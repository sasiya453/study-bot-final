// Vercel Serverless Function for Telegram Bot
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase outside the handler for better performance
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export default async function handler(req, res) {
  try {
    // 1. Handle Webhook Verification (GET request)
    if (req.method === 'GET') {
      return res.status(200).json({ status: "Study Bot is Active on Vercel!" });
    }

    // 2. Handle Telegram Updates (POST request)
    if (req.method === 'POST') {
      const update = req.body;

      if (update.callback_query) {
        await handleCallback(update.callback_query);
      } else if (update.message) {
        await handleMessage(update.message);
      }

      return res.status(200).send('OK');
    }

    // 3. Reject other methods
    return res.status(405).send('Method Not Allowed');

  } catch (error) {
    console.error('Critical Error:', error);
    return res.status(500).send('Internal Server Error');
  }
}

// --- LOGIC HANDLERS ---

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = message.text || "";
  
  // Admin Check
  const adminId = parseInt(process.env.ADMIN_ID || '0');

  // ADMIN COMMAND: /users
  if (text === '/users' && chatId === adminId) {
    const { data: users, error } = await supabase.from('user_ranks').select('*');
    if (error) return sendMessage(chatId, "❌ Database Error");
    
    let report = "📋 **Student Registry**\n\n";
    if (!users || users.length === 0) report += "No users found.";
    else {
      users.forEach((u, i) => {
        report += `${i + 1}. **${u.real_name}** (@${u.username})\n   Total: ${u.total_hours} hrs\n\n`;
      });
    }
    return sendMessage(chatId, report);
  }

  // CHECK USER REGISTRATION
  let { data: user } = await supabase.from('users').select('*').eq('telegram_id', chatId).single();

  // Registration Flow
  if (!user || (user.bot_state && user.bot_state.startsWith('REG_'))) {
    if (text === '/start' || !user) {
      if (!user) await supabase.from('users').insert({ telegram_id: chatId, bot_state: 'REG_NAME', temp_data: {} });
      else await updateUserState(chatId, 'REG_NAME', {});
      return sendMessage(chatId, "👋 **Welcome!**\n\nTo start, please enter your **Full Name**:");
    }

    if (user.bot_state === 'REG_NAME') {
      await updateUserState(chatId, 'REG_USERNAME', { ...user.temp_data, real_name: text });
      return sendMessage(chatId, `👤 Nice to meet you, ${text}!\n\nNow, enter a **Username**:`);
    }

    if (user.bot_state === 'REG_USERNAME') {
      await updateUserState(chatId, 'REG_PASSWORD', { ...user.temp_data, custom_username: text });
      return sendMessage(chatId, "bx **Security**\n\nPlease create a **Password**:");
    }

    if (user.bot_state === 'REG_PASSWORD') {
      const d = user.temp_data;
      await supabase.from('users').update({ 
        real_name: d.real_name,
        username: d.custom_username,
        password: text,
        bot_state: 'HOME',
        temp_data: {}
      }).eq('telegram_id', chatId);
      return sendHomeMenu(chatId, "✅ **Registration Complete!**");
    }
    return;
  }

  // Logged In Flow
  if (text === '/start') {
    await updateUserState(chatId, 'HOME', {});
    return sendHomeMenu(chatId, "🏠 **Home Menu**");
  }

  // --- SUBMISSION FLOW ---
  
  if (user.bot_state === 'AWAITING_YEAR') {
    const year = parseInt(text);
    if (isNaN(year)) return sendMessage(chatId, "⚠️ Invalid Year.");
    await updateUserState(chatId, 'AWAITING_MONTH', { ...user.temp_data, year });
    return sendMessage(chatId, "📅 Enter Month (1-12):", getCancelButton());
  }

  else if (user.bot_state === 'AWAITING_MONTH') {
    const month = parseInt(text);
    if (isNaN(month)) return sendMessage(chatId, "⚠️ Invalid Month.");
    await updateUserState(chatId, 'AWAITING_DATE', { ...user.temp_data, month });
    return sendMessage(chatId, "📅 Enter Day (1-31):", getCancelButton());
  }

  else if (user.bot_state === 'AWAITING_DATE') {
    const date = parseInt(text);
    if (isNaN(date)) return sendMessage(chatId, "⚠️ Invalid Day.");
    await updateUserState(chatId, 'AWAITING_SUBMISSION', { ...user.temp_data, day: date });
    return sendMessage(chatId, "📸 Send **Photo** with **Hours** in caption.", getCancelButton());
  }

  else if (user.bot_state === 'AWAITING_SUBMISSION') {
    const caption = message.caption || message.text || "";
    const hoursMatch = caption.match(/(\d+(\.\d+)?)/);
    const hours = hoursMatch ? parseFloat(hoursMatch[0]) : 0;

    if (hours === 0) return sendMessage(chatId, "⚠️ No hours found. Try 'Maths 2.5 hours'");

    const photoId = message.photo ? message.photo[message.photo.length - 1].file_id : null;
    const draftData = { ...user.temp_data, hours, subject: caption, photo_id: photoId };
    
    await updateUserState(chatId, 'CONFIRM_SUBMISSION', draftData);

    const confirmKb = {
      inline_keyboard: [
        [{ text: "Edit", callback_data: "edit_submission" }],
        [{ text: "Submit", callback_data: "confirm_submit" }],
        [{ text: "Cancel", callback_data: "cancel" }]
      ]
    };
    return sendMessage(chatId, `📝 **Confirm?**\nHours: ${hours}\nNote: ${caption}`, confirmKb);
  }
}

async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const data = query.data;

  // Answer callback
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: query.id })
  });

  if (data === 'home' || data === 'cancel') {
    await updateUserState(chatId, 'HOME', {});
    await sendHomeMenu(chatId, "🏠 **Home Menu**");
  }

  else if (data === 'profile') {
    const { data: rank } = await supabase.from('user_ranks').select('*').eq('telegram_id', chatId).single();
    const text = `👤 **My Profile**\nName: ${rank?.real_name}\nHours: ${rank?.total_hours || 0}`;
    const kb = { inline_keyboard: [[{ text: "Line Chart", callback_data: "line_chart" }], [{ text: "Home", callback_data: "home" }]] };
    await sendMessage(chatId, text, kb);
  }

  else if (data === 'line_chart') {
    const chartUrl = `https://quickchart.io/chart?c={type:'line',data:{labels:[1,2,3,4,5],datasets:[{label:'Hrs',data:[2,4,3,6,5]}]}}`;
    await sendPhoto(chatId, chartUrl, "📈 Progress");
    await sendMessage(chatId, "Back to menu?", { inline_keyboard: [[{ text: "Home", callback_data: "home" }]] });
  }

  else if (data === 'leaderboard') {
    const { data: leaders } = await supabase.from('user_ranks').select('*').limit(10);
    let text = "🏆 **Leaderboard**\n";
    if (leaders) leaders.forEach((l, i) => text += `${i+1}. ${l.real_name} - ${l.total_hours} hrs\n`);
    await sendMessage(chatId, text, { inline_keyboard: [[{ text: "Home", callback_data: "home" }]] });
  }

  else if (data === 'submit_today') {
    const today = new Date();
    await updateUserState(chatId, 'AWAITING_SUBMISSION', { year: today.getFullYear(), month: today.getMonth() + 1, day: today.getDate() });
    await sendMessage(chatId, "📸 Send Photo with Total Hours in caption:", getCancelButton());
  }

  else if (data === 'submit_old') {
    await updateUserState(chatId, 'AWAITING_YEAR', {});
    await sendMessage(chatId, "📅 Enter Year (e.g. 2025):", getCancelButton());
  }

  else if (data === 'confirm_submit') {
    const { data: user } = await supabase.from('users').select('*').eq('telegram_id', chatId).single();
    const d = user.temp_data;
    
    const { error } = await supabase.from('study_logs').insert({
      telegram_id: chatId,
      duration: d.hours,
      subject: d.subject,
      study_date: `${d.year}-${d.month}-${d.day}`
    });

    if (error) {
      await sendMessage(chatId, "❌ Error saving data.");
    } else {
      // Forward to Channel
      if (process.env.CHANNEL_ID) {
        const caption = `📅 **Update**\n👤 ${user.real_name}\n⏱ ${d.hours} hrs\n📝 ${d.subject || '-'}`;
        if (d.photo_id) await sendPhoto(process.env.CHANNEL_ID, d.photo_id, caption);
        else await sendMessage(process.env.CHANNEL_ID, caption);
      }
      await sendMessage(chatId, "✅ **Submitted!**", { inline_keyboard: [[{ text: "Home", callback_data: "home" }]] });
      await updateUserState(chatId, 'HOME', {});
    }
  }

  else if (data === 'edit_submission') {
    const { data: user } = await supabase.from('users').select('temp_data').eq('telegram_id', chatId).single();
    await updateUserState(chatId, 'AWAITING_SUBMISSION', user.temp_data);
    await sendMessage(chatId, "🔄 Send again:", getCancelButton());
  }
}

// --- HELPERS ---

async function updateUserState(chatId, state, tempData) {
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
