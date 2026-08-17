require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const express = require('express');
const ytDlpPackage = require('yt-dlp-exec');
const ytDlpPath = process.env.YT_DLP_PATH || path.join(__dirname, '.venv', 'bin', 'yt-dlp');
const ytDlp = ytDlpPackage.create(ytDlpPath);
const YouTube = require('youtube-sr').default;
const ffmpegPath = require('ffmpeg-static');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  NoSubscriberBehavior,
  StreamType,
  demuxProbe,
} = require('@discordjs/voice');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').replace(/\/$/, '');
const CLIENT_ID = process.env.CLIENT_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const GUILD_ID = process.env.GUILD_ID || '';
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PREFIX = process.env.PREFIX || '!';
const DATA_FILE = path.join(__dirname, 'config.json');
const YOUTUBE_COOKIE = process.env.YOUTUBE_COOKIE || '';

if (!CLIENT_ID || !DISCORD_TOKEN || !CLIENT_SECRET) {
  console.error('Missing CLIENT_ID, DISCORD_TOKEN or CLIENT_SECRET environment variable.');
  process.exit(1);
}


const defaultConfig = { guildId: GUILD_ID, voiceChannelId: process.env.VOICE_CHANNEL_ID || '', stay24_7: true, volume: 100 };
let config = defaultConfig;
try {
  if (fs.existsSync(DATA_FILE)) config = { ...defaultConfig, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
} catch (error) { console.error('Could not read config.json:', error.message); }
function saveConfig() { fs.writeFileSync(DATA_FILE, JSON.stringify(config, null, 2)); }

const queues = new Map();
const sessions = new Map();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.set('trust proxy', 1);

const commands = [
  new SlashCommandBuilder().setName('join').setDescription('إدخال البوت إلى رومك الصوتي أو الروم المحدد').addChannelOption(o => o.setName('channel').setDescription('الروم الصوتي').addChannelTypes(2)),
  new SlashCommandBuilder().setName('play').setDescription('تشغيل أغنية بالاسم أو الرابط').addStringOption(o => o.setName('query').setDescription('اسم الأغنية أو رابط YouTube').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('تخطي الأغنية الحالية'),
  new SlashCommandBuilder().setName('pause').setDescription('إيقاف مؤقت'),
  new SlashCommandBuilder().setName('resume').setDescription('استئناف التشغيل'),
  new SlashCommandBuilder().setName('stop').setDescription('إيقاف ومسح القائمة'),
  new SlashCommandBuilder().setName('queue').setDescription('عرض قائمة التشغيل'),
  new SlashCommandBuilder().setName('volume').setDescription('تغيير مستوى الصوت').addIntegerOption(o => o.setName('percent').setDescription('من 0 إلى 150').setMinValue(0).setMaxValue(150).setRequired(true)),
  new SlashCommandBuilder().setName('leave').setDescription('إخراج البوت من الروم'),
  new SlashCommandBuilder().setName('247').setDescription('تفعيل أو تعطيل البقاء في الروم المحدد'),
  new SlashCommandBuilder().setName('panel').setDescription('إرسال لوحة التحكم في القناة الحالية'),
].map(c => c.toJSON());

function getGuildState(guildId) {
  if (!queues.has(guildId)) queues.set(guildId, {
    guildId, items: [], current: null, connection: null, player: createAudioPlayer({ behavior: { noSubscriber: NoSubscriberBehavior.Play } }), resource: null, loop: false, textChannel: null, volume: config.volume || 100
  });
  const state = queues.get(guildId);
  state.player.removeAllListeners(AudioPlayerStatus.Idle);
  state.player.once(AudioPlayerStatus.Idle, () => playNext(guildId));
  return state;
}
function memberIsAllowed(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || interaction.user.id === ADMIN_USER_ID || !ADMIN_USER_ID;
}
function pickVoiceChannel(interaction, requested) {
  if (requested?.isVoiceBased?.()) return requested;
  const memberChannel = interaction.member?.voice?.channel;
  if (memberChannel) return memberChannel;
  if (config.guildId === interaction.guildId && config.voiceChannelId) return interaction.guild.channels.cache.get(config.voiceChannelId);
  return null;
}
async function connectToChannel(guild, channel) {
  if (!channel || !channel.isVoiceBased()) throw new Error('لم يتم العثور على روم صوتي صالح.');
  const state = getGuildState(guild.id);
  if (state.connection) state.connection.destroy();
  state.connection = joinVoiceChannel({ channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true, selfMute: false });
  state.connection.subscribe(state.player);
  state.connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try { await Promise.race([entersState(state.connection, VoiceConnectionStatus.Signalling, 5000), entersState(state.connection, VoiceConnectionStatus.Connecting, 5000)]); }
    catch { if (config.stay24_7 && config.guildId === guild.id && config.voiceChannelId) setTimeout(() => reconnectConfigured(guild.id), 5000); }
  });
  await entersState(state.connection, VoiceConnectionStatus.Ready, 20000);
  return state;
}
async function reconnectConfigured(guildId) {
  const guild = client.guilds.cache.get(guildId);
  const channel = guild?.channels.cache.get(config.voiceChannelId);
  if (!guild || !channel || !config.stay24_7) return;
  try { await connectToChannel(guild, channel); } catch (e) { console.error('Reconnect failed:', e.message); }
}
function normalizeYouTubeUrl(value) {
  try {
    const parsed = new URL(String(value).trim());
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    let videoId = '';
    if (host === 'youtu.be') videoId = parsed.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'music.youtube.com') {
      if (parsed.pathname === '/watch') videoId = parsed.searchParams.get('v') || '';
      else if (parsed.pathname.startsWith('/shorts/')) videoId = parsed.pathname.split('/')[2] || '';
      else if (parsed.pathname.startsWith('/embed/')) videoId = parsed.pathname.split('/')[2] || '';
    }
    return videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` : null;
  } catch { return null; }
}
async function resolveTrack(query, requestedBy) {
  const input = query.trim();
  const directUrl = normalizeYouTubeUrl(input);
  if (directUrl) {
    return { title: input, url: directUrl, duration: '??:??', thumbnail: null, requestedBy };
  }
  let video;
  try {
    video = await YouTube.searchOne(input);
  } catch (error) {
    console.error('YouTube search failed:', error.message);
    throw new Error('تعذر البحث في YouTube حاليًا. جرّب بعد قليل أو أرسل رابط YouTube مباشر.');
  }
  const url = normalizeYouTubeUrl(video?.url || (video?.id ? `https://www.youtube.com/watch?v=${video.id}` : ''));
  if (!video || !url) throw new Error('لم أجد فيديو YouTube صالحًا لهذا البحث.');
  return { title: video.title || 'Unknown title', url, duration: video.durationFormatted || '??:??', thumbnail: video.thumbnail?.url, requestedBy };
}
function getPlaybackUrl(track) {
  const raw = String(track?.url || '').trim();
  const youtubeUrl = normalizeYouTubeUrl(raw);
  if (youtubeUrl) return youtubeUrl;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) URLs are supported');
    return parsed.toString();
  } catch {
    throw new Error(`Invalid playback URL for track "${String(track?.title || 'unknown').slice(0, 120)}": ${raw.slice(0, 200) || '(empty)'}`);
  }
}
async function playNext(guildId) {
  const state = getGuildState(guildId);
  if (state.loop && state.current) state.items.unshift(state.current);
  const track = state.items.shift();
  if (!track) { state.current = null; return; }
  state.current = track;
  let playbackUrl = '';
  try {
    playbackUrl = getPlaybackUrl(track);
    console.log(JSON.stringify({ event: 'playback_start', guildId, title: track.title, url: playbackUrl, timestamp: new Date().toISOString() }));
    if (!state.connection) {
      const guild = client.guilds.cache.get(guildId);
      const channel = guild?.channels.cache.get(config.voiceChannelId);
      if (channel) await connectToChannel(guild, channel);
    } else {
      await entersState(state.connection, VoiceConnectionStatus.Ready, 20000);
    }
    if (!YOUTUBE_COOKIE) throw new Error('YOUTUBE_COOKIE is missing in Render Environment Variables');
    const ytdlProcess = ytDlp.exec(playbackUrl, {
      output: '-',
      format: 'ba/b',
      extractorArgs: 'youtube:player_client=android,web',
      noPlaylist: true,
      quiet: true,
      noWarnings: true,
      ignoreConfig: true,
      addHeader: `Cookie: ${YOUTUBE_COOKIE}`,
      jsRuntimes: 'node',
    });
    let audioBytes = 0;
    let ytDlpStderr = '';
    const measuredStream = new Transform({
      transform(chunk, encoding, callback) {
        audioBytes += chunk.length;
        callback(null, chunk);
      },
    });
    ytdlProcess.stderr.on('data', chunk => {
      ytDlpStderr = `${ytDlpStderr}${chunk.toString()}`.slice(-2000);
    });
    ytdlProcess.on('error', error => console.error(JSON.stringify({ event: 'yt_dlp_process_error', guildId, title: track.title, error: error.message, timestamp: new Date().toISOString() })));
    ytdlProcess.on('close', (code, signal) => console.log(JSON.stringify({ event: 'yt_dlp_closed', guildId, title: track.title, code, signal, audioBytes, stderr: ytDlpStderr.trim().slice(-1000), timestamp: new Date().toISOString() })));
    ytdlProcess.stdout.pipe(measuredStream);
    const probed = await demuxProbe(measuredStream);
    if (audioBytes === 0) {
      throw new Error(`yt-dlp returned an empty audio stream. stderr: ${ytDlpStderr.trim().slice(-500) || 'no stderr'}`);
    }
    const resource = createAudioResource(probed.stream, { inputType: probed.type || StreamType.Arbitrary, inlineVolume: true });
    resource.volume?.setVolume(Math.max(0, Math.min(1.5, state.volume / 100)));
    state.resource = resource;
    state.player.play(resource);
    await entersState(state.player, AudioPlayerStatus.Playing, 10000);
    const me = state.connection?.joinConfig?.guildId ? client.guilds.cache.get(guildId)?.members.me : null;
    console.log(JSON.stringify({ event: 'audio_resource_started', guildId, title: track.title, demuxType: probed.type, volume: state.volume, connectionState: state.connection?.state?.status || 'unknown', playerState: state.player.state.status, serverMute: me?.voice?.serverMute || false, selfMute: me?.voice?.selfMute || false, audioBytes, timestamp: new Date().toISOString() }));
    if (state.textChannel) sendNowPlaying(state.textChannel, track).catch(() => {});
  } catch (error) {
    console.error(JSON.stringify({ event: 'playback_error', guildId, title: track.title, url: playbackUrl || track.url || null, error: error.stack || error.message, timestamp: new Date().toISOString() }));
    if (state.textChannel) state.textChannel.send(`تعذر تشغيل **${track.title}**: ${error.message}`).catch(() => {});
    setTimeout(() => playNext(guildId), 1000);
  }
}
async function enqueue(guildId, query, requestedBy, textChannel) {
  const state = getGuildState(guildId);
  state.textChannel = textChannel;
  const track = await resolveTrack(query, requestedBy);
  state.items.push(track);
  if (!state.current || state.player.state.status === AudioPlayerStatus.Idle) await playNext(guildId);
  return { track, position: state.items.length + (state.current ? 1 : 0) };
}
function controlsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music_pause').setEmoji('⏯️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('music_loop').setEmoji('🔁').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_leave').setEmoji('🚪').setStyle(ButtonStyle.Secondary),
  );
}
function queueText(state) {
  const lines = [];
  if (state.current) lines.push(`**يعمل الآن:** ${state.current.title} \`[${state.current.duration}]\``);
  state.items.slice(0, 15).forEach((t, i) => lines.push(`${i + 1}. ${t.title} \`[${t.duration}]\``));
  return lines.length ? lines.join('\\n') : 'القائمة فارغة.';
}
async function sendNowPlaying(channel, track) {
  const embed = new EmbedBuilder().setColor(0x8b5cf6).setTitle(`🎵 ${track.title}`).setDescription(`تمت الإضافة بواسطة ${track.requestedBy}
\`[${track.duration}]\``).setURL(track.url);
  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  await channel.send({ embeds: [embed], components: [controlsRow()] });
}
async function handleMusicAction(interaction, action) {
  const state = getGuildState(interaction.guildId);
  if (action === 'pause') state.player.state.status === AudioPlayerStatus.Paused ? state.player.unpause() : state.player.pause();
  if (action === 'skip') state.player.stop();
  if (action === 'stop') { state.items = []; state.current = null; state.player.stop(); }
  if (action === 'loop') state.loop = !state.loop;
  if (action === 'leave') { state.items = []; state.current = null; state.player.stop(); state.connection?.destroy(); state.connection = null; }
  await interaction.reply({ content: action === 'loop' ? `التكرار: ${state.loop ? 'مفعّل' : 'معطّل'}` : 'تم تنفيذ الأمر.', ephemeral: true });
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    if (GUILD_ID) await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    else await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Slash commands registered.');
  } catch (error) { console.error('Slash command registration failed:', error.message); }
  if (config.stay24_7 && config.guildId && config.voiceChannelId) setTimeout(() => reconnectConfigured(config.guildId), 2000);
});

async function respondSafely(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) return await interaction.editReply({ content });
    return await interaction.reply({ content, ephemeral: true });
  } catch (error) {
    console.error('Interaction response failed:', error.message);
  }
}

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isButton() && interaction.customId.startsWith('music_')) return handleMusicAction(interaction, interaction.customId.replace('music_', ''));
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guild) return interaction.reply({ content: 'هذا الأمر يعمل داخل السيرفر فقط.', ephemeral: true });
    const state = getGuildState(interaction.guildId);
    if (interaction.commandName === 'join') {
      await interaction.deferReply();
      const channel = pickVoiceChannel(interaction, interaction.options.getChannel('channel'));
      await connectToChannel(interaction.guild, channel);
      return interaction.editReply(`دخلت إلى **${channel.name}**.`);
    }
    if (interaction.commandName === 'play') {
      await interaction.deferReply();
      const result = await enqueue(interaction.guildId, interaction.options.getString('query'), `<@${interaction.user.id}>`, interaction.channel);
      return interaction.editReply(`🎶 أضيفت **${result.track.title}** إلى القائمة في المركز **${result.position}**.`);
    }
    if (interaction.commandName === 'skip') { state.player.stop(); return interaction.reply('تم التخطي.'); }
    if (interaction.commandName === 'pause') { state.player.pause(); return interaction.reply('تم الإيقاف المؤقت.'); }
    if (interaction.commandName === 'resume') { state.player.unpause(); return interaction.reply('تم الاستئناف.'); }
    if (interaction.commandName === 'stop') { state.items = []; state.current = null; state.player.stop(); return interaction.reply('تم إيقاف التشغيل ومسح القائمة.'); }
    if (interaction.commandName === 'queue') return interaction.reply({ content: queueText(state), ephemeral: true });
    if (interaction.commandName === 'volume') { state.volume = interaction.options.getInteger('percent'); config.volume = state.volume; saveConfig(); if (state.resource?.volume) state.resource.volume.setVolume(state.volume / 100); return interaction.reply(`مستوى الصوت: **${state.volume}%**`); }
    if (interaction.commandName === 'leave') { state.items = []; state.current = null; state.player.stop(); state.connection?.destroy(); state.connection = null; return interaction.reply('خرجت من الروم.'); }
    if (interaction.commandName === '247') { if (!memberIsAllowed(interaction)) return interaction.reply({ content: 'لا تملك صلاحية تغيير إعداد 24/7.', ephemeral: true }); await interaction.deferReply(); config.stay24_7 = !config.stay24_7; saveConfig(); if (config.stay24_7) await reconnectConfigured(interaction.guildId); return interaction.editReply(`وضع 24/7: **${config.stay24_7 ? 'مفعّل' : 'معطّل'}**`); }
    if (interaction.commandName === 'panel') return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x8b5cf6).setTitle('لوحة تحكم الموسيقى').setDescription('استخدم الأزرار للتحكم في التشغيل. استخدم `/play` لإضافة أغنية و`/queue` لعرض القائمة.')], components: [controlsRow()] });
  } catch (error) {
    console.error(error);
    const message = error.message || 'حدث خطأ غير متوقع.';
    await respondSafely(interaction, `❌ ${message}`);
  }
});

function esc(value = '') { return String(value).replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[c])); }
function page(title, body, user) { return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{margin:0;background:#15151b;color:#eee;font-family:Arial,sans-serif}main{max-width:980px;margin:30px auto;padding:20px}h1{font-size:28px}.card{background:#24242b;border:1px solid #3a3a45;border-radius:14px;padding:20px;margin:15px 0}label{display:block;margin:12px 0 6px;color:#bbb}select,input,button{width:100%;box-sizing:border-box;padding:12px;border-radius:9px;border:1px solid #454552;background:#17171c;color:#fff;font-size:15px}button,.btn{background:#8b5cf6;border:0;cursor:pointer;text-decoration:none;display:inline-block;text-align:center;margin-top:15px}.danger{background:#dc3545}.muted{color:#aaa}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:15px}.top{display:flex;justify-content:space-between;align-items:center;gap:12px}.top a{color:#c4b5fd}</style></head><body><main>${user ? `<div class="top"><span>مسجل الدخول: <b>${esc(user.username || user.id)}</b></span><a href="/logout">تسجيل الخروج</a></div>` : ''}${body}</main></body></html>`; }
function currentUser(req) { const sid = req.headers.cookie?.match(/sid=([^;]+)/)?.[1]; return sid ? sessions.get(sid) : null; }
function requireAuth(req, res, next) { const user = currentUser(req); if (!user) return res.redirect('/login'); if (ADMIN_USER_ID && user.id !== ADMIN_USER_ID) return res.status(403).send(page('ممنوع', '<h1>لا تملك صلاحية دخول اللوحة.</h1>', user)); req.user = user; next(); }
function cookieOptions(maxAge = 86400) { return `HttpOnly; ${PUBLIC_URL.startsWith('https://') ? 'Secure; ' : ''}SameSite=Lax; Path=/; Max-Age=${maxAge}`; }
function oauthUrl(state) { const redirect = `${PUBLIC_URL || `http://localhost:${PORT}`}/oauth/callback`; return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(CLIENT_ID)}&response_type=code&redirect_uri=${encodeURIComponent(redirect)}&scope=identify%20guilds&state=${encodeURIComponent(state)}`; }
app.get('/health', (req, res) => res.json({ ok: true, bot: client.user?.tag || null }));
app.get('/login', (req, res) => { const state = crypto.randomBytes(24).toString('hex'); sessions.set(`oauth:${state}`, { created: Date.now() }); res.send(page('تسجيل الدخول', '<h1>لوحة تحكم البوت</h1><p class="muted">سجّل دخولك بحساب Discord لإدارة الروم الصوتي والقائمة.</p><a class="btn" href="' + oauthUrl(state) + '">تسجيل الدخول عبر Discord</a>')); });
app.get('/oauth/callback', async (req, res) => { try { const pending = sessions.get(`oauth:${req.query.state}`); if (!pending || Date.now() - pending.created > 10 * 60 * 1000) return res.status(400).send('Invalid or expired OAuth state.'); sessions.delete(`oauth:${req.query.state}`); const redirect_uri = `${PUBLIC_URL || `http://localhost:${PORT}`}/oauth/callback`; const tokenResponse = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code', code: req.query.code, redirect_uri }) }); const token = await tokenResponse.json(); if (!token.access_token) throw new Error('OAuth token exchange failed'); const userResponse = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } }); const user = await userResponse.json(); const sid = crypto.randomBytes(32).toString('hex'); sessions.set(sid, { ...user, created: Date.now() }); res.setHeader('Set-Cookie', `sid=${sid}; ${cookieOptions()}`); res.redirect('/'); } catch (error) { res.status(500).send(`OAuth error: ${esc(error.message)}`); } });
app.get('/logout', (req, res) => { const sid = req.headers.cookie?.match(/sid=([^;]+)/)?.[1]; if (sid) sessions.delete(sid); res.setHeader('Set-Cookie', `sid=; ${cookieOptions(0)}`); res.redirect('/login'); });
app.get('/', requireAuth, async (req, res) => { const guilds = client.guilds.cache.map(g => `<option value="${g.id}" ${g.id === config.guildId ? 'selected' : ''}>${esc(g.name)}</option>`).join(''); const channelMap = Object.fromEntries(client.guilds.cache.map(g => [g.id, g.channels.cache.filter(c => c.isVoiceBased()).map(c => ({ id: c.id, name: c.name }))])); const selected = client.guilds.cache.get(config.guildId); const channels = selected ? selected.channels.cache.filter(c => c.isVoiceBased()).map(c => `<option value="${c.id}" ${c.id === config.voiceChannelId ? 'selected' : ''}>${esc(c.name)}</option>`).join('') : ''; const state = config.guildId ? queues.get(config.guildId) : null; const body = `<div class="top"><h1>لوحة تحكم الموسيقى</h1><span class="muted">${client.user ? 'البوت متصل' : 'البوت غير متصل'}</span></div><div class="card"><h2>الروم الصوتي الدائم</h2><form method="post" action="/settings"><label>السيرفر</label><select name="guildId" id="guild" onchange="loadChannels()">${guilds || '<option>لا يوجد سيرفر</option>'}</select><label>الروم الصوتي</label><select name="voiceChannelId" id="voice">${channels || '<option>اختر السيرفر أولًا</option>'}</select><label><input style="width:auto" type="checkbox" name="stay24_7" ${config.stay24_7 ? 'checked' : ''}> إعادة إدخال البوت تلقائيًا بعد الانقطاع</label><button>حفظ ودخول الروم</button></form></div><div class="grid"><div class="card"><h2>الحالة</h2><p>${state?.current ? `يشغّل: <b>${esc(state.current.title)}</b>` : 'لا توجد أغنية تعمل الآن.'}</p><p>عدد الأغاني في القائمة: ${state?.items?.length || 0}</p><p>الصوت: ${state?.volume || config.volume || 100}%</p></div><div class="card"><h2>روابط سريعة</h2><p><a class="btn" href="/api/status">عرض الحالة بصيغة JSON</a></p><p class="muted">الأوامر الأساسية: /join، /play، /skip، /pause، /resume، /stop، /queue، /volume، /leave، /247، /panel</p></div></div><script>const channelMap=${JSON.stringify(channelMap)};function loadChannels(){const guild=document.getElementById('guild').value;const voice=document.getElementById('voice');voice.innerHTML='';(channelMap[guild]||[]).forEach(c=>{const o=document.createElement('option');o.value=c.id;o.textContent=c.name;voice.appendChild(o)})}</script>`; res.send(page('لوحة التحكم', body, req.user)); });
app.post('/settings', requireAuth, async (req, res) => { const guild = client.guilds.cache.get(req.body.guildId); const channel = guild?.channels.cache.get(req.body.voiceChannelId); if (!guild || !channel || !channel.isVoiceBased()) return res.status(400).send(page('خطأ', '<h1>السيرفر أو الروم غير صالح.</h1>', req.user)); config.guildId = guild.id; config.voiceChannelId = channel.id; config.stay24_7 = req.body.stay24_7 === 'on'; saveConfig(); if (config.stay24_7) { try { await connectToChannel(guild, channel); } catch (e) { console.error(e.message); } } res.redirect('/'); });
app.get('/api/status', requireAuth, (req, res) => { const state = queues.get(config.guildId); res.json({ config, current: state?.current || null, queue: state?.items || [], connected: Boolean(state?.connection) }); });

app.listen(PORT, '0.0.0.0', () => console.log(`Dashboard listening on port ${PORT}`));
client.login(DISCORD_TOKEN);
