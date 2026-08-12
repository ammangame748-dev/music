require('dotenv').config();
const http = require('http');

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
  PermissionsBitField
} = require('discord.js');

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState
} = require('@discordjs/voice');

const play = require('play-dl');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const SoundcloudModule = require('soundcloud.ts');
const Soundcloud = SoundcloudModule.default || SoundcloudModule;

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || '';
const PREFIX = process.env.PREFIX || '!';

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID environment variable.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const queues = new Map();
const searchCache = new Map();
const soundcloud = new Soundcloud(
  process.env.SOUNDCLOUD_CLIENT_ID,
  process.env.SOUNDCLOUD_OAUTH_TOKEN
);

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('تشغيل أغنية أو إضافتها إلى قائمة الانتظار')
    .addStringOption(o => o.setName('song').setDescription('اسم الأغنية أو رابط يوتيوب').setRequired(true)),
  new SlashCommandBuilder().setName('search').setDescription('البحث عن أغنية واختيار نتيجة')
    .addStringOption(o => o.setName('song').setDescription('اسم الأغنية').setRequired(true)),
  new SlashCommandBuilder().setName('queue').setDescription('عرض قائمة الانتظار'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('عرض الأغنية الحالية'),
  new SlashCommandBuilder().setName('skip').setDescription('تخطي الأغنية الحالية'),
  new SlashCommandBuilder().setName('pause').setDescription('إيقاف مؤقت'),
  new SlashCommandBuilder().setName('resume').setDescription('استئناف التشغيل'),
  new SlashCommandBuilder().setName('stop').setDescription('إيقاف البوت ومسح القائمة'),
  new SlashCommandBuilder().setName('shuffle').setDescription('خلط قائمة الانتظار'),
  new SlashCommandBuilder().setName('loop').setDescription('تفعيل أو تعطيل التكرار'),
  new SlashCommandBuilder().setName('volume').setDescription('تغيير مستوى الصوت')
    .addIntegerOption(o => o.setName('percent').setDescription('من 1 إلى 100').setMinValue(1).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName('help').setDescription('عرض أوامر البوت')
].map(c => c.toJSON());

function getQueue(guildId) {
  if (!queues.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
    });
    const data = {
      guildId,
      voiceChannelId: null,
      connection: null,
      player,
      songs: [],
      current: null,
      loop: false,
      volume: 80,
      textChannelId: null,
      manuallyStopped: false
    };

    player.on(AudioPlayerStatus.Idle, async () => {
      const q = queues.get(guildId);
      if (!q || q.manuallyStopped) return;
      if (q.current && q.loop) q.songs.unshift(q.current);
      q.current = null;
      await playNext(guildId);
    });

    player.on('error', async error => {
      console.error(`[${guildId}] Audio error:`, error.message);
      const q = queues.get(guildId);
      if (!q) return;
      q.current = null;
      await sendText(q, `تعذر تشغيل الأغنية الحالية، انتقلت للأغنية التالية.`);
      await playNext(guildId);
    });

    queues.set(guildId, data);
  }
  return queues.get(guildId);
}

function controlRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music_pause').setLabel('إيقاف مؤقت').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_resume').setLabel('استئناف').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('music_skip').setLabel('التالي').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('music_queue').setLabel('القائمة').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_stop').setLabel('إيقاف').setStyle(ButtonStyle.Danger)
  );
}

function songEmbed(song, title = 'تمت إضافة الأغنية') {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title)
    .setDescription(`[${song.title}](${song.url})`)
    .addFields(
      { name: 'المدة', value: song.duration || 'غير معروف', inline: true },
      { name: 'القناة', value: song.channel || 'YouTube', inline: true },
      { name: 'أضيفت بواسطة', value: song.requestedBy || 'عضو', inline: true }
    )
    .setFooter({ text: 'Naghma Music • تحكم من الأزرار بالأسفل' });
  if (song.thumbnail) embed.setThumbnail(song.thumbnail);
  return embed;
}

async function sendText(queue, content, options = {}) {
  try {
    const channel = await client.channels.fetch(queue.textChannelId);
    if (channel) return channel.send({ content, ...options });
  } catch (error) {
    console.error('Could not send message:', error.message);
  }
}

function isYouTubeUrl(value) {
  return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(value);
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function normalizeSoundcloudTrack(track) {
  return {
    id: track.id,
    title: track.title,
    url: track.permalink_url,
    duration: formatDuration(track.duration),
    channel: track.user?.username || 'SoundCloud',
    thumbnail: track.artwork_url || track.user?.avatar_url || null,
    requestedBy: 'عضو',
    source: 'SoundCloud'
  };
}

async function findSongs(query, limit = 1) {
  let tracks;
  if (/^https?:\/\/soundcloud\.com\//i.test(query)) {
    tracks = [await soundcloud.tracks.get(query)];
  } else {
    const result = await soundcloud.tracks.search({ q: query });
    tracks = Array.isArray(result) ? result : (result.collection || []);
  }
  return tracks.filter(Boolean).slice(0, limit).map(normalizeSoundcloudTrack);
}

async function connectToVoice(interaction, queue) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) throw new Error('يجب أن تدخل روم صوتي أولًا.');

  if (queue.connection && queue.voiceChannelId === voiceChannel.id) return queue.connection;
  if (queue.connection) queue.connection.destroy();

  queue.voiceChannelId = voiceChannel.id;
  queue.connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: interaction.guild.id,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: true
  });
  queue.connection.subscribe(queue.player);
  queue.connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(queue.connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(queue.connection, VoiceConnectionStatus.Connecting, 5000)
      ]);
    } catch {
      queue.connection.destroy();
    }
  });
  return queue.connection;
}

function createAudioResourceFromUrl(url, volume) {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', url, '-analyzeduration', '0', '-loglevel', '0',
    '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
  ];
  const ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  return createAudioResource(ffmpeg.stdout, { inputType: 1, inlineVolume: true, silencePaddingFrames: 5, metadata: { url } });
}

async function playNext(guildId) {
  const queue = queues.get(guildId);
  if (!queue || queue.current || queue.songs.length === 0) {
    if (queue && !queue.current && queue.songs.length === 0 && queue.connection) {
      setTimeout(() => {
        const q = queues.get(guildId);
        if (q && !q.current && q.songs.length === 0 && q.connection) {
          q.connection.destroy();
          q.connection = null;
          q.voiceChannelId = null;
        }
      }, 60000);
    }
    return;
  }

  queue.current = queue.songs.shift();
  try {
    const soundcloudStream = await soundcloud.util.streamTrack(queue.current.url);
    const ffmpeg = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'ignore'] });

    soundcloudStream.pipe(ffmpeg.stdin);
    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: 1,
      inlineVolume: true,
      metadata: { song: queue.current }
    });
    if (resource.volume) resource.volume.setVolume(queue.volume / 100);
    queue.player.play(resource);
    await sendText(queue, '', { embeds: [songEmbed(queue.current, 'يعمل الآن')], components: [controlRow()] });
  } catch (error) {
    console.error('Stream error:', error.message);
    queue.current = null;
    await sendText(queue, 'حدث خطأ أثناء تشغيل الأغنية، سأنتقل للتالية.');
    await playNext(guildId);
  }
}

function queueEmbed(queue) {
  const list = queue.songs.slice(0, 10).map((song, i) => `**${i + 1}.** [${song.title}](${song.url}) — ${song.duration}`).join('\n');
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('قائمة الانتظار')
    .setDescription(list || 'القائمة فارغة حاليًا.')
    .addFields({ name: 'يعمل الآن', value: queue.current ? `[${queue.current.title}](${queue.current.url})` : 'لا توجد أغنية' })
    .setFooter({ text: `عدد الأغاني المنتظرة: ${queue.songs.length}` });
}

function requireVoice(interaction, queue) {
  if (!interaction.member?.voice?.channel) throw new Error('يجب أن تدخل نفس الروم الصوتي مع البوت.');
  if (queue.voiceChannelId && interaction.member.voice.channel.id !== queue.voiceChannelId) {
    throw new Error('يجب أن تكون في نفس الروم الصوتي مع البوت.');
  }
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const route = GUILD_ID ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID) : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log(GUILD_ID ? `Commands registered in guild ${GUILD_ID}` : 'Global commands registered.');
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity('/play اسم الأغنية', { type: 2 });
  console.log('SoundCloud client ready.');
  try { await registerCommands(); } catch (error) { console.error('Command registration failed:', error.message); }
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isButton()) {
      const queue = getQueue(interaction.guildId);
      requireVoice(interaction, queue);
      if (interaction.customId === 'music_pause') queue.player.pause();
      else if (interaction.customId === 'music_resume') queue.player.unpause();
      else if (interaction.customId === 'music_skip') queue.player.stop();
      else if (interaction.customId === 'music_queue') return interaction.reply({ embeds: [queueEmbed(queue)], ephemeral: true });
      else if (interaction.customId === 'music_stop') {
        queue.manuallyStopped = true;
        queue.songs = [];
        queue.current = null;
        queue.player.stop();
        if (queue.connection) queue.connection.destroy();
        queue.connection = null;
        queue.voiceChannelId = null;
        queue.manuallyStopped = false;
      }
      return interaction.reply({ content: 'تم تنفيذ الأمر.', ephemeral: true });
    }

    if (!interaction.isChatInputCommand() && !interaction.isStringSelectMenu()) return;

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('song_select:')) {
      const queryId = interaction.customId.split(':')[1];
      const results = searchCache.get(queryId);
      if (!results) return interaction.reply({ content: 'انتهت صلاحية نتائج البحث. استخدم /search من جديد.', ephemeral: true });
      const selected = results[Number(interaction.values[0])];
      const queue = getQueue(interaction.guildId);
      await connectToVoice(interaction, queue);
      queue.textChannelId = interaction.channelId;
      selected.requestedBy = interaction.user.tag;
      queue.songs.push(selected);
      await interaction.update({ content: `تمت إضافة **${selected.title}** إلى القائمة.`, embeds: [], components: [] });
      await playNext(interaction.guildId);
      return;
    }

    const queue = getQueue(interaction.guildId);
    queue.textChannelId = interaction.channelId;

    if (interaction.commandName === 'help') {
      const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('أوامر Naghma Music').setDescription(commands.map(c => `**/${c.name}** — ${c.description}`).join('\n'));
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === 'play') {
      await interaction.deferReply();
      const query = interaction.options.getString('song');
      await connectToVoice(interaction, queue);
      const songs = await findSongs(query, 1);
      if (!songs.length) return interaction.editReply('لم أجد أغنية بهذا الاسم.');
      songs[0].requestedBy = interaction.user.tag;
      queue.songs.push(songs[0]);
      await interaction.editReply({ embeds: [songEmbed(songs[0])], components: [controlRow()] });
      await playNext(interaction.guildId);
      return;
    }

    if (interaction.commandName === 'search') {
      await interaction.deferReply({ ephemeral: true });
      const query = interaction.options.getString('song');
      const results = await findSongs(query, 5);
      if (!results.length) return interaction.editReply('لم أجد نتائج.');
      const id = `${interaction.id}`;
      searchCache.set(id, results);
      setTimeout(() => searchCache.delete(id), 120000);
      const menu = new StringSelectMenuBuilder().setCustomId(`song_select:${id}`).setPlaceholder('اختر أغنية للتشغيل');
      results.forEach((song, i) => menu.addOptions({ label: song.title.slice(0, 100), description: `${song.duration} • ${song.channel}`.slice(0, 100), value: String(i) }));
      return interaction.editReply({ content: 'اختر النتيجة المطلوبة:', components: [new ActionRowBuilder().addComponents(menu)] });
    }

    if (interaction.commandName === 'queue') return interaction.reply({ embeds: [queueEmbed(queue)] });
    if (interaction.commandName === 'nowplaying') return interaction.reply(queue.current ? { embeds: [songEmbed(queue.current, 'يعمل الآن')], components: [controlRow()] } : { content: 'لا توجد أغنية تعمل حاليًا.' });

    requireVoice(interaction, queue);
    if (interaction.commandName === 'skip') {
      queue.player.stop();
      return interaction.reply('تم تخطي الأغنية.');
    }
    if (interaction.commandName === 'pause') {
      queue.player.pause();
      return interaction.reply('تم الإيقاف المؤقت.');
    }
    if (interaction.commandName === 'resume') {
      queue.player.unpause();
      return interaction.reply('تم الاستئناف.');
    }
    if (interaction.commandName === 'stop') {
      queue.songs = [];
      queue.current = null;
      queue.player.stop();
      if (queue.connection) queue.connection.destroy();
      queue.connection = null;
      queue.voiceChannelId = null;
      return interaction.reply('تم إيقاف الموسيقى ومسح القائمة.');
    }
    if (interaction.commandName === 'shuffle') {
      for (let i = queue.songs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue.songs[i], queue.songs[j]] = [queue.songs[j], queue.songs[i]];
      }
      return interaction.reply('تم خلط قائمة الانتظار.');
    }
    if (interaction.commandName === 'loop') {
      queue.loop = !queue.loop;
      return interaction.reply(`التكرار الآن: **${queue.loop ? 'مفعّل' : 'متوقف'}**.`);
    }
    if (interaction.commandName === 'volume') {
      queue.volume = interaction.options.getInteger('percent');
      const resource = queue.player.state.resource;
      if (resource?.volume) resource.volume.setVolume(queue.volume / 100);
      return interaction.reply(`تم ضبط الصوت على **${queue.volume}%**.`);
    }
  } catch (error) {
    console.error(error);
    const message = error.message || 'حدث خطأ غير متوقع.';
    if (interaction.deferred) return interaction.editReply(message).catch(() => {});
    if (interaction.replied) return interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
    return interaction.reply({ content: message, ephemeral: true }).catch(() => {});
  }
});

process.on('unhandledRejection', error => console.error('Unhandled rejection:', error));
process.on('uncaughtException', error => console.error('Uncaught exception:', error));

const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (path === '/' || path === '/health') {
    const payload = {
      ok: true,
      service: 'Naghma Music Bot',
      botReady: client.isReady(),
      uptime: Math.floor(process.uptime()),
      time: new Date().toISOString()
    };
    res.writeHead(200);
    return res.end(JSON.stringify(payload));
  }

  res.writeHead(404);
  return res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Health server listening on port ${PORT}`);
});

client.login(TOKEN);
