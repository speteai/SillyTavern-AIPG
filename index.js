// AI Power Grid images and video for SillyTavern. Unofficial, community-built.
//
// SillyTavern's image generation extension has no source that can be pointed
// at the grid, so this small extension talks to it directly from the browser:
// slash commands, entries in the wand menu and, if switched on, tools the chat
// model can call. Chat itself needs no extension: use the built-in
// "Custom (OpenAI-compatible)" source with https://api.aipowergrid.io/v1.
import { saveBase64AsFile } from '/scripts/utils.js';
import { getMessageTimeStamp, humanizedDateTime } from '/scripts/RossAscends-mods.js';

const NAME = 'aipg';
const API = 'https://api.aipowergrid.io/v1';
const KEY_PAGE = 'https://console.aipowergrid.io/?callbackUrl=%2Fdashboard%2Fapi-key';
const SIZES = ['1024x1024', '1344x768', '768x1344', '1216x832', '832x1216'];
const DEFAULT_MODEL = 'z-image-turbo';
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const VIDEO_SIZES = ['960x544', '768x448', '544x960', '704x704'];
const VIDEO_SECONDS = [2, 3, 5, 8, 10];
const VIDEO_FPS = 24;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_START_PICTURE_BYTES = 12 * 1024 * 1024;
const VIDEO_POLL_MS = 5000;
const CLIENT = { 'X-AIPG-Client': 'sillytavern-aipg/0.2.0' };
const DEFAULTS = { key: '', model: DEFAULT_MODEL, size: SIZES[0], tool: false, vmodel: '', vsize: VIDEO_SIZES[0], vseconds: 3, vtool: false };

const ctx = () => SillyTavern.getContext();

function settings() {
    const all = ctx().extensionSettings;
    if (!all[NAME]) all[NAME] = {};
    for (const [k, v] of Object.entries(DEFAULTS)) if (all[NAME][k] === undefined) all[NAME][k] = v;
    return all[NAME];
}

function save() {
    ctx().saveSettingsDebounced();
}

const usd = (n) => '$' + (Math.abs(n) > 0 && Math.abs(n) < 0.01 ? Number(n).toFixed(4) : Number(n).toFixed(2));

function apiKey() {
    const key = String(settings().key || '').trim();
    if (!key) throw new Error('No AI Power Grid API key yet: add one under Extensions → AI Power Grid.');
    return key;
}

async function gridError(r, what) {
    let detail = '';
    try {
        const j = await r.json();
        const d = j && (j.detail ?? j.error);
        detail = typeof d === 'string' ? d : d && d.message ? d.message : JSON.stringify(d ?? j);
    } catch {
        // no JSON body
    }
    const hint =
        r.status === 401 || r.status === 403 ? ' Check the API key in the extension settings.'
            : r.status === 402 ? ' The grid account has no spendable credit.'
                : r.status === 429 ? ' Too many requests; wait a minute.'
                    : '';
    return new Error(`AI Power Grid ${what} failed (HTTP ${r.status})${detail && detail !== 'null' ? ': ' + detail : ''}.${hint}`);
}

// Models of one kind ('image' or 'video') that have a worker right now, with their list price where one is published.
async function onlineModels(kind) {
    const [status, pricing] = await Promise.all([
        fetch(`${API}/status/models`, { headers: { Accept: 'application/json' } }).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API}/pricing`, { headers: { Accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    const rate = kind === 'video' ? 'per_video_second_usd' : 'per_image_usd';
    const prices = new Map(
        (pricing?.price_book?.models || []).map((m) => [String(m.model).toLowerCase(), Number(m.rates?.[rate])]),
    );
    return (Array.isArray(status) ? status : [])
        .filter((m) => m && m.type === kind && (m.count || 0) > 0)
        .map((m) => ({ name: String(m.name), price: prices.get(String(m.name).toLowerCase()) }));
}

// Only https links to the grid's own storage are opened.
function gridMediaUrl(value) {
    try {
        const u = new URL(String(value));
        const host = u.hostname.toLowerCase();
        const own = ['.aipg.art', '.aipowergrid.io'].some((s) => host.endsWith(s) && host.length > s.length);
        return u.protocol === 'https:' && !u.username && !u.password && own ? u : null;
    } catch {
        return null;
    }
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read the file.'));
        reader.readAsDataURL(blob);
    });
}

const blobToBase64 = async (blob) => (await blobToDataUrl(blob)).split(',', 2)[1] || '';

function imageFormat(base64) {
    if (base64.startsWith('UklGR')) return 'webp';
    if (base64.startsWith('iVBOR')) return 'png';
    if (base64.startsWith('/9j/')) return 'jpg';
    return null;
}

// Asks the grid for one image and returns { base64, format, model }.
async function requestImage(prompt, { model, size } = {}) {
    const s = settings();
    const key = apiKey();
    const body = { model: model || s.model || DEFAULT_MODEL, prompt, n: 1, size: SIZES.includes(size) ? size : (SIZES.includes(s.size) ? s.size : SIZES[0]) };
    const r = await fetch(`${API}/images/generations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json', ...CLIENT },
        body: JSON.stringify(body),
    });
    if (!r.ok) throw await gridError(r, 'image generation');
    const item = (await r.json())?.data?.[0];
    let base64 = '';
    if (typeof item?.b64_json === 'string' && item.b64_json) {
        base64 = item.b64_json;
    } else if (item?.url) {
        const u = gridMediaUrl(item.url);
        if (!u) throw new Error('AI Power Grid returned an image link that does not point to its own storage; it was not opened.');
        const d = await fetch(u, { redirect: 'error' });
        if (!d.ok) throw new Error(`AI Power Grid image download failed (HTTP ${d.status}).`);
        const blob = await d.blob();
        if (blob.size > MAX_IMAGE_BYTES) throw new Error('The image from AI Power Grid is larger than allowed.');
        base64 = await blobToBase64(blob);
    }
    const format = imageFormat(base64);
    if (!base64 || !format) throw new Error('AI Power Grid returned no usable image.');
    return { base64, format, model: body.model };
}

// Puts a picture or a clip into the current chat as a message of the character.
async function postMedia(prompt, media, kind = 'image') {
    const c = ctx();
    const name = c.name2 || 'AI Power Grid';
    const path = await saveBase64AsFile(media.base64, name, `aipg_${humanizedDateTime()}`, media.format);
    const title = `${prompt} (AI Power Grid, ${media.model})`;
    const message = { name, is_user: false, is_system: false, send_date: getMessageTimeStamp(), mes: '', extra: { title } };
    // Newer SillyTavern keeps media in a list; older builds know only `image` and `video`.
    const constants = await import('/scripts/constants.js').catch(() => ({}));
    if (constants.MEDIA_TYPE && constants.MEDIA_SOURCE && constants.MEDIA_DISPLAY) {
        const type = kind === 'video' ? constants.MEDIA_TYPE.VIDEO : constants.MEDIA_TYPE.IMAGE;
        message.extra.media = [{ url: path, type, title, source: constants.MEDIA_SOURCE.GENERATED }];
        message.extra.media_display = constants.MEDIA_DISPLAY.GALLERY;
        message.extra.media_index = 0;
        message.extra.inline_image = false;
    } else if (kind === 'video') {
        message.extra.video = path;
    } else {
        message.extra.image = path;
        message.extra.inline_image = false;
    }
    c.chat.push(message);
    const id = c.chat.length - 1;
    await c.eventSource.emit(c.eventTypes.MESSAGE_RECEIVED, id, 'extension');
    c.addOneMessage(message);
    await c.eventSource.emit(c.eventTypes.CHARACTER_MESSAGE_RENDERED, id, 'extension');
    await c.saveChat();
    return path;
}

let busy = false;

// The whole thing: ask, save, post. Returns the saved path, or '' when it failed.
async function generate(prompt, options = {}) {
    prompt = String(prompt || '').trim();
    if (!prompt) {
        toastr.warning('Describe the image first.', 'AI Power Grid');
        return '';
    }
    if (busy) {
        toastr.info('An image is already being generated.', 'AI Power Grid');
        return '';
    }
    busy = true;
    const note = toastr.info('Generating… this takes 10 to 60 seconds.', 'AI Power Grid', { timeOut: 0, extendedTimeOut: 0 });
    try {
        const image = await requestImage(prompt, options);
        return await postMedia(prompt, image);
    } catch (err) {
        console.error('[AIPG]', err);
        toastr.error(String(err?.message || err), 'AI Power Grid', { timeOut: 10000 });
        return '';
    } finally {
        busy = false;
        toastr.clear(note);
    }
}

/* ---------- video ----------
   The grid takes a video as a job: POST /videos/jobs answers at once with a job
   id, and the clip is fetched from GET /videos/jobs/{id} when it is done. A job
   cannot be cancelled and is billed when it completes, so every started job is
   written into the browser's storage first and collected even after a reload.
   (SillyTavern saves extension settings with a delay, which is too late when the
   page is closed right after the start.) */
const JOBS_KEY = 'aipg_video_jobs';
let jobsMemory = [];

function jobs() {
    try {
        const list = JSON.parse(localStorage.getItem(JOBS_KEY) || '[]');
        return Array.isArray(list) ? list : [];
    } catch {
        return jobsMemory; // storage blocked: the list lives until the page is closed
    }
}

function jobsSave(list) {
    jobsMemory = list;
    try {
        localStorage.setItem(JOBS_KEY, JSON.stringify(list));
    } catch {
        // storage blocked
    }
}

function jobPatch(key, patch) {
    const list = jobs();
    const j = list.find((x) => x.key === key);
    if (j) Object.assign(j, patch);
    jobsSave(list);
}

function uuid() {
    if (window.crypto?.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function jobDrop(key) {
    jobsSave(jobs().filter((j) => j.key !== key));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The newest picture in the open chat, as a path SillyTavern serves.
function lastChatImage() {
    const chat = ctx().chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const extra = chat[i]?.extra || {};
        const media = Array.isArray(extra.media) ? extra.media.filter((m) => m && m.type === 'image' && m.url) : [];
        if (media.length) return String(media[media.length - 1].url);
        if (extra.image) return String(extra.image);
    }
    return '';
}

// Reads the start picture ('last' or a path inside this SillyTavern) as a data URL.
async function startPicture(value) {
    let ref = String(value || '').trim();
    if (!ref) return '';
    if (ref.toLowerCase() === 'last') {
        ref = lastChatImage();
        if (!ref) throw new Error('There is no picture in this chat to start the clip from.');
    }
    const u = new URL(ref, window.location.href);
    if (u.origin !== window.location.origin) throw new Error('The start picture must be a picture inside this SillyTavern (or "last"), not a web link.');
    const r = await fetch(u);
    if (!r.ok) throw new Error(`Could not read the start picture (HTTP ${r.status}).`);
    const blob = await r.blob();
    if (!blob.type.startsWith('image/')) throw new Error('The start picture is not an image file.');
    if (blob.size > MAX_START_PICTURE_BYTES) throw new Error('The start picture is larger than 12 MB.');
    return blobToDataUrl(blob);
}

// Sends the job. Returns the job entry; throws when the grid refused it (then nothing runs and nothing is billed).
async function startVideo(prompt, { model, size, seconds, image } = {}) {
    const s = settings();
    const key = apiKey();
    const wanted = Number(seconds) || Number(s.vseconds) || 3;
    const length = Math.max(...VIDEO_SECONDS.filter((x) => x <= wanted), VIDEO_SECONDS[0]);
    const format = VIDEO_SIZES.includes(size) ? size : (VIDEO_SIZES.includes(s.vsize) ? s.vsize : VIDEO_SIZES[0]);
    const online = await onlineModels('video');
    const name = model || s.vmodel || online[0]?.name;
    if (!name) throw new Error('No video model is online on AI Power Grid right now.');
    const rate = online.find((m) => m.name.toLowerCase() === String(name).toLowerCase())?.price;
    if (!(rate > 0)) throw new Error(`The video model ${name} is offline or has no published price; nothing was sent.`);
    const data = await startPicture(image);
    // the most this clip may cost: the published price plus a little room for rounding
    const body = { model: name, prompt, frames: length * VIDEO_FPS + 1, size: format, max_cost_micro_usd: Math.ceil(rate * length * 1e6) + 1000 };
    if (data) body.image = data;
    // written down before sending: if the answer is lost, the job is found again by this key
    const job = { key: uuid(), job: '', t: Date.now(), prompt, model: name, seconds: length, size: format };
    jobsSave([...jobs(), job]);
    let r;
    try {
        r = await fetch(`${API}/videos/jobs`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Idempotency-Key': job.key, ...CLIENT },
            body: JSON.stringify(body),
        });
    } catch {
        return job; // no answer: the job may or may not exist; the checks ask by key
    }
    if (r.status !== 200 && r.status !== 202) {
        jobDrop(job.key);
        const err = await gridError(r, 'video request');
        err.message += ' Nothing was billed.';
        throw err;
    }
    const d = await r.json().catch(() => null);
    job.job = String(d?.job_id || '');
    jobPatch(job.key, { job: job.job });
    return job;
}

// One look at a job. Returns 'open', 'gone', or the finished job description of the grid.
async function checkVideo(job) {
    const key = apiKey();
    const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json', ...CLIENT };
    const r = job.job
        ? await fetch(`${API}/videos/jobs/${encodeURIComponent(job.job)}`, { headers })
        : await fetch(`${API}/videos/jobs`, { headers: { ...headers, 'Idempotency-Key': job.key } });
    const age = Date.now() - (job.t || 0);
    // 404: never accepted (asked by key), or no longer kept by the grid
    if (r.status === 404) return (job.job ? age > 86400000 : age > 120000) ? 'gone' : 'open';
    if (!r.ok) return 'open';
    const d = await r.json().catch(() => null);
    if (!d) return 'open';
    if (!job.job && d.job_id) {
        job.job = String(d.job_id);
        jobPatch(job.key, { job: job.job });
    }
    return d.state === 'completed' || d.state === 'closed_without_result' ? d : 'open';
}

// Downloads the finished clip and posts it. Returns the saved path.
async function finishVideo(job, d) {
    const billed = typeof d.actual_micro === 'number' ? d.actual_micro / 1e6 : null;
    if (d.state !== 'completed') {
        jobDrop(job.key);
        throw new Error('AI Power Grid ended the clip without a result' + (billed > 0 ? ` and billed ${usd(billed)}.` : '; nothing was billed.'));
    }
    const u = gridMediaUrl(d.result?.media?.[0]?.url);
    if (!u) {
        jobDrop(job.key);
        throw new Error('AI Power Grid reports the clip as done but sent no file from its own storage.');
    }
    const r = await fetch(u, { redirect: 'error' });
    if (!r.ok) throw new Error(`AI Power Grid video download failed (HTTP ${r.status}).`);
    const blob = await r.blob();
    if (blob.size > MAX_VIDEO_BYTES) throw new Error('The clip from AI Power Grid is larger than allowed.');
    const base64 = await blobToBase64(blob);
    // an MP4 file has "ftyp" at byte 4
    if (!base64 || atob(base64.slice(0, 16)).slice(4, 8) !== 'ftyp') throw new Error('AI Power Grid returned no usable video file.');
    const path = await postMedia(job.prompt, { base64, format: 'mp4', model: d.model || job.model }, 'video');
    jobDrop(job.key);
    toastr.success(`Video ready${billed > 0 ? ` (${usd(billed)})` : ''}.`, 'AI Power Grid');
    return path;
}

// Waits for one job while the page is open. Returns the saved path, or '' when the job is gone.
async function awaitVideo(job) {
    for (;;) {
        let d = 'open';
        try {
            d = await checkVideo(job);
        } catch (err) {
            if (!String(settings().key || '').trim()) throw err;
            // offline: try again
        }
        if (d === 'gone') {
            jobDrop(job.key);
            throw new Error(job.job ? 'The clip is no longer kept by AI Power Grid.' : 'AI Power Grid never received the video request. Nothing was billed.');
        }
        if (d !== 'open') return finishVideo(job, d);
        await sleep(VIDEO_POLL_MS);
    }
}

let videoBusy = false;

// Start, wait, save, post. Returns the saved path, or '' when it failed.
async function generateVideo(prompt, options = {}) {
    prompt = String(prompt || '').trim();
    if (!prompt) {
        toastr.warning('Describe the clip first.', 'AI Power Grid');
        return '';
    }
    if (videoBusy) {
        toastr.info('A clip is already being generated.', 'AI Power Grid');
        return '';
    }
    videoBusy = true;
    const note = toastr.info('Generating a clip… this takes from 20 seconds to a few minutes. It is fetched even if you reload the page.', 'AI Power Grid', { timeOut: 0, extendedTimeOut: 0 });
    try {
        const job = await startVideo(prompt, options);
        return await awaitVideo(job);
    } catch (err) {
        console.error('[AIPG]', err);
        toastr.error(String(err?.message || err), 'AI Power Grid', { timeOut: 10000 });
        return '';
    } finally {
        videoBusy = false;
        toastr.clear(note);
    }
}

// Clips that were started before a reload: fetched into the chat that is open now.
async function collectVideos() {
    const open = jobs();
    if (!open.length || videoBusy || !String(settings().key || '').trim()) return;
    if (!ctx().getCurrentChatId?.()) return; // no chat to post into yet; tried again when one is opened
    videoBusy = true;
    try {
        for (const job of open) {
            try {
                await awaitVideo(job);
            } catch (err) {
                console.error('[AIPG]', err);
                toastr.error(String(err?.message || err), 'AI Power Grid', { timeOut: 10000 });
            }
        }
    } finally {
        videoBusy = false;
    }
}

async function showCredit() {
    const key = String(settings().key || '').trim();
    const out = $('#aipg_credit');
    if (!key) return out.text('Add an API key first.');
    out.text('Checking…');
    try {
        const r = await fetch(`${API}/account/credits`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...CLIENT } });
        if (!r.ok) throw await gridError(r, 'credit check');
        const c = await r.json();
        const free = c.free && Number(c.free.daily_cap_usd) > 0 ? `, of which ${usd(Number(c.free.remaining_usd) || 0)} is today's free allowance` : '';
        out.text(`Spendable: ${usd(Number(c.total_spendable_usd) || 0)}${free}.`);
    } catch (err) {
        out.text(String(err?.message || err));
    }
}

async function fillModels() {
    const s = settings();
    const lists = await Promise.all(['image', 'video'].map((kind) => onlineModels(kind).catch(() => [])));
    for (const [select, models, stored, unit] of [[$('#aipg_model'), lists[0], s.model, 'per image'], [$('#aipg_vmodel'), lists[1], s.vmodel, 'per second']]) {
        select.empty();
        // offline: keep what is stored
        if (stored && !models.some((m) => m.name === stored)) models.unshift({ name: stored, price: undefined, offline: models.length > 0 });
        if (!models.length) select.append($('<option>').val('').text('(none online)'));
        for (const m of models) {
            const label = m.name + (m.price > 0 ? ` (${usd(m.price)} ${unit})` : '') + (m.offline ? ' (offline)' : '');
            select.append($('<option>').val(m.name).text(label));
        }
        select.val(stored || models[0]?.name || '');
    }
}

function registerTool() {
    const c = ctx();
    if (typeof c.unregisterFunctionTool === 'function') {
        c.unregisterFunctionTool('aipg_generate_image');
        c.unregisterFunctionTool('aipg_generate_video');
    }
    if (typeof c.registerFunctionTool !== 'function') return;
    if (settings().tool) {
        c.registerFunctionTool({
            name: 'aipg_generate_image',
            displayName: 'AI Power Grid image',
            description: 'Generate an image on AI Power Grid and show it in the chat. Use when the user asks for a picture, or when a scene would clearly gain from one. It costs the user a fraction of a cent.',
            parameters: {
                $schema: 'http://json-schema.org/draft-04/schema#',
                type: 'object',
                properties: { prompt: { type: 'string', description: 'What the image shows: subject, setting, style. English works best.' } },
                required: ['prompt'],
            },
            action: async ({ prompt }) => ((await generate(prompt)) ? 'The image was generated and shown to the user.' : 'The image could not be generated.'),
            formatMessage: () => 'Generating an image on AI Power Grid…',
        });
    }
    if (settings().vtool) {
        c.registerFunctionTool({
            name: 'aipg_generate_video',
            displayName: 'AI Power Grid video',
            description: 'Generate a short video clip with sound on AI Power Grid and show it in the chat. Use only when the user asks for a video or clip. It costs the user a few cents per clip and takes from 20 seconds to a few minutes.',
            parameters: {
                $schema: 'http://json-schema.org/draft-04/schema#',
                type: 'object',
                properties: { prompt: { type: 'string', description: 'What the clip shows: subject and what it does, setting, camera movement, what is heard. English works best.' } },
                required: ['prompt'],
            },
            action: async ({ prompt }) => ((await generateVideo(prompt)) ? 'The clip was generated and shown to the user.' : 'The clip could not be generated.'),
            formatMessage: () => 'Generating a clip on AI Power Grid…',
        });
    }
}

function addSettings() {
    const s = settings();
    const html = `
    <div class="aipg_settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>AI Power Grid images and video</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <label for="aipg_key">API key</label>
          <input id="aipg_key" class="text_pole" type="password" placeholder="grid_…" autocomplete="off">
          <small>Create one in the <a href="${KEY_PAGE}" target="_blank" rel="noopener noreferrer">AIPG Console</a>.
            It is stored in SillyTavern's settings, in plain text, like other extension settings.</small>
          <label for="aipg_model">Image model</label>
          <div class="flex-container">
            <select id="aipg_model" class="text_pole flex1"></select>
            <div id="aipg_refresh" class="menu_button fa-solid fa-rotate" title="Read the models that are online"></div>
          </div>
          <label for="aipg_size">Image size</label>
          <select id="aipg_size" class="text_pole"></select>
          <label class="checkbox_label" for="aipg_tool">
            <input id="aipg_tool" type="checkbox">
            <span>Let the chat model generate images by itself (needs function calling)</span>
          </label>
          <label for="aipg_vmodel">Video model</label>
          <select id="aipg_vmodel" class="text_pole"></select>
          <div class="flex-container">
            <div class="flex1">
              <label for="aipg_vseconds">Clip length</label>
              <select id="aipg_vseconds" class="text_pole"></select>
            </div>
            <div class="flex1">
              <label for="aipg_vsize">Clip format</label>
              <select id="aipg_vsize" class="text_pole"></select>
            </div>
          </div>
          <label class="checkbox_label" for="aipg_vtool">
            <input id="aipg_vtool" type="checkbox">
            <span>Let the chat model generate clips by itself (needs function calling; a clip costs a few cents)</span>
          </label>
          <div class="flex-container alignItemsCenter">
            <div id="aipg_credit_check" class="menu_button">Check credit</div>
            <span id="aipg_credit"></span>
          </div>
          <small>Use <code>/aipg a description</code>, <code>/aipg-video a description</code> or the wand menu. A clip is billed
            per second of video and cannot be cancelled once started. Your prompt is processed in plain text on a
            computer run by an independent operator: keep private details out of it.</small>
        </div>
      </div>
    </div>`;
    $('#extensions_settings2').append(html);
    for (const size of SIZES) $('#aipg_size').append($('<option>').val(size).text(size));
    for (const size of VIDEO_SIZES) $('#aipg_vsize').append($('<option>').val(size).text(size));
    for (const n of VIDEO_SECONDS) $('#aipg_vseconds').append($('<option>').val(String(n)).text(`${n} seconds`));
    $('#aipg_key').val(s.key).on('input', function () { s.key = String($(this).val()).trim(); save(); });
    $('#aipg_size').val(s.size).on('change', function () { s.size = String($(this).val()); save(); });
    $('#aipg_model').on('change', function () { s.model = String($(this).val()); save(); });
    $('#aipg_tool').prop('checked', !!s.tool).on('change', function () { s.tool = !!$(this).prop('checked'); save(); registerTool(); });
    $('#aipg_vmodel').on('change', function () { s.vmodel = String($(this).val()); save(); });
    $('#aipg_vsize').val(s.vsize).on('change', function () { s.vsize = String($(this).val()); save(); });
    $('#aipg_vseconds').val(String(s.vseconds)).on('change', function () { s.vseconds = Number($(this).val()) || 3; save(); });
    $('#aipg_vtool').prop('checked', !!s.vtool).on('change', function () { s.vtool = !!$(this).prop('checked'); save(); registerTool(); });
    $('#aipg_refresh').on('click', fillModels);
    $('#aipg_credit_check').on('click', showCredit);
    fillModels();
}

function addWandButtons() {
    const image = $(`
      <div id="aipg_wand" class="list-group-item flex-container flexGap5" title="Generate an image on AI Power Grid">
        <div class="fa-solid fa-bolt extensionsMenuExtensionButton"></div>
        <span>AI Power Grid image</span>
      </div>`);
    image.on('click', async () => {
        const c = ctx();
        const prompt = await c.callGenericPopup('Describe the image', c.POPUP_TYPE.INPUT, '');
        if (typeof prompt === 'string' && prompt.trim()) generate(prompt);
    });
    const video = $(`
      <div id="aipg_wand_video" class="list-group-item flex-container flexGap5" title="Generate a video clip on AI Power Grid">
        <div class="fa-solid fa-film extensionsMenuExtensionButton"></div>
        <span>AI Power Grid video</span>
      </div>`);
    video.on('click', async () => {
        const c = ctx();
        const prompt = await c.callGenericPopup('Describe the clip: what is seen, how it moves, what is heard', c.POPUP_TYPE.INPUT, '');
        if (typeof prompt === 'string' && prompt.trim()) generateVideo(prompt);
    });
    $('#extensionsMenu').append(image, video);
}

function addCommands() {
    const c = ctx();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, ARGUMENT_TYPE } = c;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'aipg',
        aliases: ['aipg-image'],
        callback: async (args, value) => generate(String(value || ''), { model: args?.model ? String(args.model) : undefined, size: args?.size ? String(args.size) : undefined }),
        returns: 'the path of the saved image, or an empty string when it failed',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'what the image shows', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        namedArgumentList: SlashCommandNamedArgument ? [
            SlashCommandNamedArgument.fromProps({ name: 'model', description: 'image model, default from the settings', typeList: [ARGUMENT_TYPE.STRING] }),
            SlashCommandNamedArgument.fromProps({ name: 'size', description: 'one of ' + SIZES.join(', '), typeList: [ARGUMENT_TYPE.STRING], enumList: SIZES }),
        ] : [],
        helpString: '<div>Generates an image on AI Power Grid and adds it to the chat.</div><div><code>/aipg size=1344x768 a harbour town at dawn, oil painting</code></div>',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'aipg-video',
        callback: async (args, value) => generateVideo(String(value || ''), {
            model: args?.model ? String(args.model) : undefined,
            size: args?.size ? String(args.size) : undefined,
            seconds: args?.seconds ? Number(args.seconds) : undefined,
            image: args?.image ? String(args.image) : undefined,
        }),
        returns: 'the path of the saved clip, or an empty string when it failed',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'what the clip shows and what is heard', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        namedArgumentList: SlashCommandNamedArgument ? [
            SlashCommandNamedArgument.fromProps({ name: 'seconds', description: 'length, one of ' + VIDEO_SECONDS.join(', '), typeList: [ARGUMENT_TYPE.NUMBER], enumList: VIDEO_SECONDS.map(String) }),
            SlashCommandNamedArgument.fromProps({ name: 'size', description: 'one of ' + VIDEO_SIZES.join(', '), typeList: [ARGUMENT_TYPE.STRING], enumList: VIDEO_SIZES }),
            SlashCommandNamedArgument.fromProps({ name: 'image', description: '"last" to start from the newest picture in this chat, or the path of a picture inside SillyTavern', typeList: [ARGUMENT_TYPE.STRING] }),
            SlashCommandNamedArgument.fromProps({ name: 'model', description: 'video model, default from the settings', typeList: [ARGUMENT_TYPE.STRING] }),
        ] : [],
        helpString: '<div>Generates a short video clip with sound on AI Power Grid and adds it to the chat.</div><div><code>/aipg-video seconds=3 image=last the camera slowly pushes in, wind in the trees</code></div>',
    }));
}

jQuery(() => {
    try {
        addSettings();
        addWandButtons();
        addCommands();
        registerTool();
        const c = ctx();
        if (c.eventTypes?.CHAT_CHANGED) c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => { collectVideos(); });
        setTimeout(collectVideos, 5000);
    } catch (err) {
        console.error('[AIPG] could not start', err);
    }
});
