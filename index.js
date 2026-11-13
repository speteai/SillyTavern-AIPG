// AI Power Grid images for SillyTavern. Unofficial, community-built.
//
// SillyTavern's image generation extension has no source that can be pointed
// at the grid, so this small extension talks to it directly from the browser:
// a slash command, an entry in the wand menu and, if switched on, a tool the
// chat model can call. Chat itself needs no extension: use the built-in
// "Custom (OpenAI-compatible)" source with https://api.aipowergrid.io/v1.
import { saveBase64AsFile } from '/scripts/utils.js';
import { getMessageTimeStamp, humanizedDateTime } from '/scripts/RossAscends-mods.js';

const NAME = 'aipg';
const API = 'https://api.aipowergrid.io/v1';
const KEY_PAGE = 'https://console.aipowergrid.io/?callbackUrl=%2Fdashboard%2Fapi-key';
const SIZES = ['1024x1024', '1344x768', '768x1344', '1216x832', '832x1216'];
const DEFAULT_MODEL = 'z-image-turbo';
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const CLIENT = { 'X-AIPG-Client': 'sillytavern-aipg/0.1.0' };
const DEFAULTS = { key: '', model: DEFAULT_MODEL, size: SIZES[0], tool: false };

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

// Image models that have a worker right now, with their list price where one is published.
async function onlineImageModels() {
    const [status, pricing] = await Promise.all([
        fetch(`${API}/status/models`, { headers: { Accept: 'application/json' } }).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API}/pricing`, { headers: { Accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    const prices = new Map(
        (pricing?.price_book?.models || []).map((m) => [String(m.model).toLowerCase(), Number(m.rates?.per_image_usd)]),
    );
    return (Array.isArray(status) ? status : [])
        .filter((m) => m && m.type === 'image' && (m.count || 0) > 0)
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

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '');
        reader.onerror = () => reject(new Error('Could not read the image.'));
        reader.readAsDataURL(blob);
    });
}

function imageFormat(base64) {
    if (base64.startsWith('UklGR')) return 'webp';
    if (base64.startsWith('iVBOR')) return 'png';
    if (base64.startsWith('/9j/')) return 'jpg';
    return null;
}

// Asks the grid for one image and returns { base64, format, model }.
async function requestImage(prompt, { model, size } = {}) {
    const s = settings();
    const key = String(s.key || '').trim();
    if (!key) throw new Error('No AI Power Grid API key yet: add one under Extensions → AI Power Grid images.');
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

// Puts the picture into the current chat as a message of the character.
async function postImage(prompt, image) {
    const c = ctx();
    const name = c.name2 || 'AI Power Grid';
    const path = await saveBase64AsFile(image.base64, name, `aipg_${humanizedDateTime()}`, image.format);
    const title = `${prompt} (AI Power Grid, ${image.model})`;
    const message = { name, is_user: false, is_system: false, send_date: getMessageTimeStamp(), mes: '', extra: { title } };
    // Newer SillyTavern keeps media in a list; older builds know only `image`.
    const constants = await import('/scripts/constants.js').catch(() => ({}));
    if (constants.MEDIA_TYPE && constants.MEDIA_SOURCE && constants.MEDIA_DISPLAY) {
        message.extra.media = [{ url: path, type: constants.MEDIA_TYPE.IMAGE, title, source: constants.MEDIA_SOURCE.GENERATED }];
        message.extra.media_display = constants.MEDIA_DISPLAY.GALLERY;
        message.extra.media_index = 0;
        message.extra.inline_image = false;
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
        return await postImage(prompt, image);
    } catch (err) {
        console.error('[AIPG]', err);
        toastr.error(String(err?.message || err), 'AI Power Grid', { timeOut: 10000 });
        return '';
    } finally {
        busy = false;
        toastr.clear(note);
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
    const select = $('#aipg_model');
    const s = settings();
    let models = [];
    try {
        models = await onlineImageModels();
    } catch {
        // offline: keep what is stored
    }
    select.empty();
    if (!models.some((m) => m.name === s.model)) models.unshift({ name: s.model, price: undefined, offline: models.length > 0 });
    for (const m of models) {
        const label = m.name + (m.price > 0 ? ` (${usd(m.price)} per image)` : '') + (m.offline ? ' (offline)' : '');
        select.append($('<option>').val(m.name).text(label));
    }
    select.val(s.model);
}

function registerTool() {
    const c = ctx();
    if (typeof c.unregisterFunctionTool === 'function') c.unregisterFunctionTool('aipg_generate_image');
    if (!settings().tool || typeof c.registerFunctionTool !== 'function') return;
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

function addSettings() {
    const s = settings();
    const html = `
    <div class="aipg_settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>AI Power Grid images</b>
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
          <label for="aipg_size">Size</label>
          <select id="aipg_size" class="text_pole"></select>
          <label class="checkbox_label" for="aipg_tool">
            <input id="aipg_tool" type="checkbox">
            <span>Let the chat model generate images by itself (needs function calling)</span>
          </label>
          <div class="flex-container alignItemsCenter">
            <div id="aipg_credit_check" class="menu_button">Check credit</div>
            <span id="aipg_credit"></span>
          </div>
          <small>Use <code>/aipg a description</code> or the wand menu. Your image prompt is processed in plain text on a
            computer run by an independent operator: keep private details out of it.</small>
        </div>
      </div>
    </div>`;
    $('#extensions_settings2').append(html);
    for (const size of SIZES) $('#aipg_size').append($('<option>').val(size).text(size));
    $('#aipg_key').val(s.key).on('input', function () { s.key = String($(this).val()).trim(); save(); });
    $('#aipg_size').val(s.size).on('change', function () { s.size = String($(this).val()); save(); });
    $('#aipg_model').on('change', function () { s.model = String($(this).val()); save(); });
    $('#aipg_tool').prop('checked', !!s.tool).on('change', function () { s.tool = !!$(this).prop('checked'); save(); registerTool(); });
    $('#aipg_refresh').on('click', fillModels);
    $('#aipg_credit_check').on('click', showCredit);
    fillModels();
}

function addWandButton() {
    const button = $(`
      <div id="aipg_wand" class="list-group-item flex-container flexGap5" title="Generate an image on AI Power Grid">
        <div class="fa-solid fa-bolt extensionsMenuExtensionButton"></div>
        <span>AI Power Grid image</span>
      </div>`);
    button.on('click', async () => {
        const c = ctx();
        const prompt = await c.callGenericPopup('Describe the image', c.POPUP_TYPE.INPUT, '');
        if (typeof prompt === 'string' && prompt.trim()) generate(prompt);
    });
    $('#extensionsMenu').append(button);
}

function addCommand() {
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
}

jQuery(() => {
    try {
        addSettings();
        addWandButton();
        addCommand();
        registerTool();
    } catch (err) {
        console.error('[AIPG] could not start', err);
    }
});
