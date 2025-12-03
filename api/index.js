import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // Only allow POST requests (Webhooks)
  if (req.method !== 'POST') {
    return res.status(200).send('Study Bot Active');
  }

  try {
    const update = req.body;
    
    // Connect to Supabase
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY
    );

    // Handle Telegram Updates
    if (update.callback_query) {
      await handleCallback(update.callback_query, supabase);
    } else if (update.message) {
      await handleMessage(update.message, supabase);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Internal Server Error');
  }
}

// --- LOGIC HANDLERS ---

async function handleMessage(message, supabase) {
  const chatId = message.chat.id;
  const text = message.text;
  const adminId = parseInt(process.env.ADMIN_ID || '7888205421');

  // 1. ADMIN COMMAND
  if (text === '/users' && chatId === adminId) {
    const { data: users, error } = await supabase.from('user_ranks').select('*');
    if (error) return sendMessage(chatId, "❌ DB Error");
    
    let report = "📋 **Student Registry**\n\n";
    users.forEach((u, i) => {
      report += `${i + 1}. **${u.real_name}** (@${u.username})\n   Total: ${u.total_hours} hrs\n\n`;
    });
    return sendMessage(chatId, report);
  }

  // 2. CHECK REGISTRATION
  let { data: user } = await supabase.from('users').select('*').eq('telegram_id', chatId).single();

  if (!user || (user.bot_state && user.bot_state.startsWith('REG_'))) {
    if (text === '/start' || !user) {
      if (!user) await supabase.from('users').insert({ telegram_id: chatId, bot_state: 'REG_NAME', temp_data: {} });
      else await updateUserState(chatId, 'REG_NAME', {}, supabase);
      return sendMessage(chatId, "👋 **Welcome!**\n\n1️⃣ Please enter your **Full Name**:");
    }
    if (user.bot_state === 'REG_NAME') {
      await updateUserState(chatId, 'REG_USERNAME', { ...user.temp_data, real_name: text }, supabase);
      return sendMessage(chatId, `👤 Nice to meet you, ${text}!\n\n2️⃣ Now, enter a **Username**:`);
    }
    if (user.bot_state === 'REG_USERNAME') {
      await updateUserState(chatId, 'REG_PASSWORD', { ...user.temp_data, custom_username: text }, supabase);
      return sendMessage(chatId, "🔒 **Security**\n\n3️⃣ Create a **Password**:");
    }
    if (user.bot_state === 'REG_PASSWORD') {
      const d = user.temp_data;
      await supabase.from('users').update({ 
        real_name: d.real_name, username: d.custom_username, password: text, bot_state: 'HOME', temp_data: {}
      }).eq('telegram_id', chatId);
      return sendHomeMenu(chatId, "✅ **Registration Complete!**");
    }
    return;
  }

  // 3. MAIN FLOW
  if (text === '/start') {
    await updateUserState(chatId, 'HOME', {}, supabase);
    return sendHomeMenu(chatId, "🏠 **Home Menu**");
  }

  // Submission Flow
  if (user.bot_state === 'AWAITING_YEAR') {
    const year = parseInt(text);
    if (isNaN(year)) return sendMessage(chatId, "⚠️ Invalid year.");
    await updateUserState(chatId, 'AWAITING_MONTH', { ...user.temp_data, year }, supabase);
    return sendMessage(chatId, "📅 Enter Month (1-12):", getCancelButton());
  }
  else if (user.bot_state === 'AWAITING_MONTH') {
    await updateUserState(chatId, 'AWAITING_DATE', { ...user.temp_data, month: parseInt(text) }, supabase);
    return sendMessage(chatId, "📅 Enter Day (1-31):", getCancelButton());
  }
  else if (user.bot_state === 'AWAITING_DATE') {
    await updateUserState(chatId, 'AWAITING_SUBMISSION', { ...user.temp_data, day: parseInt(text) }, supabase);
    return sendMessage(chatId, "📸 Send **Photo** with **Hours** in caption.", getCancelButton());
  }
  else if (user.bot_state === 'AWAITING_SUBMISSION') {
    const caption = message.caption || message.text || "";
    const hours = (caption.match(/(\d+(\.\d+)?)/) || [0])[0];
    if (hours == 0) return sendMessage(chatId, "⚠️ No hours found.");

    const photoId = message.photo ? message.photo[message.photo.length - 1].file_id : null;
    const draft = { ...user.temp_data, hours: parseFloat(hours), subject: caption, photo_id: photoId };
    
    await updateUserState(chatId, 'CONFIRM_SUBMISSION', draft, supabase);
    return sendMessage(chatId, `📝 **Confirm?**\nHours: ${hours}\nNote: ${caption}`, {
      inline_keyboard: [[{text:"Submit",callback_data:"confirm_submit"},{text:"Cancel",callback_data:"cancel"}]]
    });
  }
}

async function handleCallback(query, supabase) {
  const chatId = query.message.chat.id;
  const data = query.data;

  // Answer callback (prevent loading spinner)
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: query.id })
  });

  if (data === 'home' || data === 'cancel') {
    await updateUserState(chatId, 'HOME', {}, supabase);
    await sendHomeMenu(chatId, "🏠 **Home Menu**");
  }
  else if (data === 'profile') {
    const { data: rank } = await supabase.from('user_ranks').select('*').eq('telegram_id', chatId).single();
    const text = `👤 **My Profile**\nName: ${rank?.real_name}\nHours: ${rank?.total_hours || 0}`;
    await sendMessage(chatId, text, { inline_keyboard: [[{text:"Home",callback_data:"home"}]] });
  }
  else if (data === 'leaderboard') {
    const { data: leaders } = await supabase.from('user_ranks').select('*').limit(10);
    let text = "🏆 **Leaderboard**\n";
    if (leaders) leaders.forEach((l, i) => text += `${i+1}. ${l.real_name} - ${l.total_hours} hrs\n`);
    await sendMessage(chatId, text, { inline_keyboard: [[{text:"Home",callback_data:"home"}]] });
  }
  else if (data === 'submit_today') {
    const today = new Date();
    await updateUserState(chatId, 'AWAITING_SUBMISSION', { year: today.getFullYear(), month: today.getMonth()+1, day: today.getDate() }, supabase);
    await sendMessage(chatId, "📸 Send Photo with Hours:", getCancelButton());
  }
  else if (data === 'submit_old') {
    await updateUserState(chatId, 'AWAITING_YEAR', {}, supabase);
    await sendMessage(chatId, "📅 Enter Year:", getCancelButton());
  }
  else if (data === 'confirm_submit') {
    const { data: user } = await supabase.from('users').select('*').eq('telegram_id', chatId).single();
    const d = user.temp_data;
    
    await supabase.from('study_logs').insert({
      telegram_id: chatId, duration: d.hours, subject: d.subject, study_date: `${d.year}-${d.month}-${d.day}`
    });

    if (process.env.CHANNEL_ID) {
      const caption = `📅 **Update**\n👤 ${user.real_name}\n⏱ ${d.hours} hrs\n📝 ${d.subject || '-'}`;
      if (d.photo_id) await sendPhoto(process.env.CHANNEL_ID, d.photo_id, caption);
      else await sendMessage(process.env.CHANNEL_ID, caption);
    }
    
    await sendMessage(chatId, "✅ **Submitted!**", { inline_keyboard: [[{text:"Home",callback_data:"home"}]] });
    await updateUserState(chatId, 'HOME', {}, supabase);
  }
}

// --- HELPERS ---

async function updateUserState(chatId, state, tempData, supabase) {
  await supabase.from('users').update({ bot_state: state, temp_data: tempData }).eq('telegram_id', chatId);
}

function getCancelButton() {
  return { inline_keyboard: [[{ text: "Cancel", callback_data: "cancel" }]] };
}

async function sendHomeMenu(chatId, text) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "My profile", callback_data: "profile" }],
      [{ text: "Top 10", callback_data: "leaderboard" }],
      [{ text: "Today submission", callback_data: "submit_today" }],
      [{ text: "Old date submission", callback_data: "submit_old" }]
    ]
  };
  await sendMessage(chatId, text, keyboard);
}

async function sendMessage(chatId, text, keyboard = null) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', reply_markup: keyboard })
  });
}

async function sendPhoto(chatId, photo, caption) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendPhoto`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, photo, caption, parse_mode: 'Markdown' })
  });
}
