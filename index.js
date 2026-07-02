/* eslint-disable */
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const nodeFs = require('fs');
let winapi;
try { winapi = require('winapi-bindings'); } catch (e) { winapi = null; }
const { fs, util, log } = require('vortex-api');

const GAME_ID = 'drovaforsakenkin';
const STEAM_APP_ID = '1585180';
const GOG_APP_ID = '1254250206';
const NEXUS_SLUG = 'drovaforsakenkin';
const GAME_EXE = 'Drova.exe';

// MelonLoader install paths inside the game folder
const ML_PROXY_DLL = 'version.dll';
const ML_DIR = 'MelonLoader';
const MODS_DIR = 'Mods';
const TRANSLATIONS_DIR = path.join('Drova_Data', 'StreamingAssets', 'Localization');

// Latest MelonLoader x64 release zip (LavaGang/MelonLoader)
const MELON_ASSET_NAME = 'MelonLoader.x64.zip';
const MELON_DOWNLOAD_URL =
  'https://github.com/LavaGang/MelonLoader/releases/latest/download/' + MELON_ASSET_NAME;
const MELON_LATEST_API =
  'https://api.github.com/repos/LavaGang/MelonLoader/releases/latest';
const ML_VERSION_MARKER = path.join(ML_DIR, '.vortex-installed-version');

// IL2CPP MelonLoader needs the .NET 6 Desktop Runtime (x64) at runtime; the
// manual MelonLoader.x64.zip does not bundle it.
const DOTNET6_DOWNLOAD_URL =
  'https://dotnet.microsoft.com/download/dotnet/6.0/runtime?runtime=desktop&os=windows&arch=x64';

// Idle socket timeout for HTTP requests. Resets on socket activity, so a slow
// but progressing download is fine; only a fully stalled connection trips it.
// Without this a half-open socket would leave the request promise unsettled
// forever, hanging game setup.
const HTTP_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Game discovery
// ---------------------------------------------------------------------------

function findGame() {
  if (winapi) {
    try {
      const instPath = winapi.RegGetValue(
        'HKEY_LOCAL_MACHINE',
        'SOFTWARE\\WOW6432Node\\GOG.com\\Games\\' + GOG_APP_ID,
        'PATH');
      if (instPath && instPath.value) {
        return Promise.resolve(instPath.value);
      }
    } catch (err) { /* fall through to store helper */ }
  }
  return util.GameStoreHelper.findByAppId([STEAM_APP_ID, GOG_APP_ID])
    .then(game => game.gamePath);
}

function modsRelPath() {
  return '.';
}

// ---------------------------------------------------------------------------
// MelonLoader detection + install
// ---------------------------------------------------------------------------

async function isMelonLoaderInstalled(gamePath) {
  // Only count it as installed if the files are really there: version.dll plus
  // a non-empty MelonLoader/ folder. An empty folder left over from a failed
  // extract shouldn't block a fresh reinstall.
  try {
    const st = await fs.statAsync(path.join(gamePath, ML_PROXY_DLL));
    if (!st.isFile() || st.size === 0) return false;
  } catch (e) {
    return false;
  }
  try {
    const dir = path.join(gamePath, ML_DIR);
    const st = await fs.statAsync(dir);
    if (!st.isDirectory()) return false;
    const entries = await fs.readdirAsync(dir);
    return Array.isArray(entries) && entries.length > 0;
  } catch (e) {
    return false;
  }
}

function fetchText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const doRequest = (currentUrl, remaining) => {
      const req = https.get(
        currentUrl,
        { headers: {
            'User-Agent': 'Vortex-Drova-Extension',
            'Accept': 'application/vnd.github+json',
        } },
        (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            if (remaining <= 0) {
              reject(new Error('Too many redirects'));
              res.resume();
              return;
            }
            const next = res.headers.location;
            res.resume();
            if (!next) {
              reject(new Error('Redirect with no location header'));
              return;
            }
            doRequest(next, remaining - 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error('HTTP ' + res.statusCode));
            res.resume();
            return;
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => resolve(body));
          res.on('error', reject);
        });
      req.on('error', reject);
      req.setTimeout(HTTP_IDLE_TIMEOUT_MS, () => {
        req.destroy(new Error('Request timed out'));
      });
    };
    doRequest(url, redirectsLeft);
  });
}

// Grabs the latest release info. sha256 comes from GitHub's asset digest when
// it's there; any field can be null if we're offline or it isn't published.
async function getLatestMelonRelease() {
  try {
    const body = await fetchText(MELON_LATEST_API);
    const data = JSON.parse(body);
    const tag = (data && typeof data.tag_name === 'string') ? data.tag_name : null;
    let downloadUrl = null;
    let sha256 = null;
    if (data && Array.isArray(data.assets)) {
      const asset = data.assets.find(a => a && a.name === MELON_ASSET_NAME);
      if (asset) {
        if (typeof asset.browser_download_url === 'string') {
          downloadUrl = asset.browser_download_url;
        }
        if (typeof asset.digest === 'string') {
          const m = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest.trim());
          if (m) sha256 = m[1].toLowerCase();
        }
      }
    }
    return { tag, downloadUrl, sha256 };
  } catch (err) {
    log('warn', '[drova] getLatestMelonRelease failed', { err: err && err.message });
    return { tag: null, downloadUrl: null, sha256: null };
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = nodeFs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function getInstalledMelonVersion(gamePath) {
  try {
    const buf = await fs.readFileAsync(path.join(gamePath, ML_VERSION_MARKER));
    const v = buf.toString('utf8').trim();
    return v || null;
  } catch (e) {
    return null;
  }
}

async function writeInstalledMelonVersion(gamePath, tag) {
  if (!tag) return;
  try {
    await fs.writeFileAsync(path.join(gamePath, ML_VERSION_MARKER), tag, 'utf8');
  } catch (err) {
    log('warn', '[drova] writeInstalledMelonVersion failed', { err: err && err.message });
  }
}

function downloadToFile(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const doRequest = (currentUrl, remaining) => {
      const req = https.get(
        currentUrl,
        { headers: { 'User-Agent': 'Vortex-Drova-Extension' } },
        (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            if (remaining <= 0) {
              reject(new Error('Too many redirects fetching MelonLoader'));
              res.resume();
              return;
            }
            const next = res.headers.location;
            res.resume();
            if (!next) {
              reject(new Error('Redirect with no location header'));
              return;
            }
            doRequest(next, remaining - 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error('MelonLoader download failed: HTTP ' + res.statusCode));
            res.resume();
            return;
          }
          const out = nodeFs.createWriteStream(destPath);
          const fail = (err) => { out.destroy(); nodeFs.unlink(destPath, () => reject(err)); };
          res.pipe(out);
          out.on('finish', () => out.close(() => resolve()));
          res.on('error', fail);
          out.on('error', fail);
        });
      req.on('error', reject);
      req.setTimeout(HTTP_IDLE_TIMEOUT_MS, () => {
        req.destroy(new Error('MelonLoader download timed out'));
      });
    };
    doRequest(url, redirectsLeft);
  });
}

async function installMelonLoader(api, gamePath, opts = {}) {
  const isUpdate = !!opts.isUpdate;
  const latestTag = opts.latestTag || null;
  const downloadUrl = opts.downloadUrl || MELON_DOWNLOAD_URL;
  const expectedSha = opts.sha256 || null;
  const tmpDir = path.join(os.tmpdir(), 'vortex-drova-melonloader');
  try {
    await fs.ensureDirWritableAsync(tmpDir);
  } catch (e) {
    try { nodeFs.mkdirSync(tmpDir, { recursive: true }); } catch (e2) { /* ignore */ }
  }
  const zipPath = path.join(tmpDir, 'MelonLoader.x64.zip');

  api.sendNotification({
    id: 'drova-melon-installing',
    type: 'activity',
    message: isUpdate ? 'Updating MelonLoader…' : 'Downloading MelonLoader…',
  });

  try {
    await downloadToFile(downloadUrl, zipPath);
  } catch (err) {
    api.dismissNotification('drova-melon-installing');
    api.showErrorNotification('Failed to download MelonLoader', err, { allowReport: false });
    return false;
  }

  // Check the download against the published checksum if we have one. A
  // mismatch means a bad or tampered file, so don't extract it.
  if (expectedSha) {
    let actualSha;
    try {
      actualSha = await sha256File(zipPath);
    } catch (err) {
      try { await fs.removeAsync(zipPath); } catch (e) { /* ignore */ }
      api.dismissNotification('drova-melon-installing');
      api.showErrorNotification('Failed to verify MelonLoader download', err, { allowReport: false });
      return false;
    }
    if (actualSha.toLowerCase() !== expectedSha) {
      try { await fs.removeAsync(zipPath); } catch (e) { /* ignore */ }
      log('error', '[drova] MelonLoader hash mismatch', { expectedSha, actualSha });
      api.dismissNotification('drova-melon-installing');
      api.showErrorNotification(
        'MelonLoader verification failed',
        new Error('Downloaded archive did not match the published SHA-256 checksum. '
          + 'The download may be corrupted or tampered with; installation was aborted.'),
        { allowReport: false });
      return false;
    }
    log('info', '[drova] MelonLoader hash verified', { sha256: actualSha });
  } else {
    log('warn', '[drova] no published SHA-256 for MelonLoader asset; skipping hash verification');
  }

  try {
    const szip = new util.SevenZip();
    await szip.extractFull(zipPath, gamePath, { ssc: false });
  } catch (err) {
    api.dismissNotification('drova-melon-installing');
    api.showErrorNotification('Failed to extract MelonLoader', err, { allowReport: false });
    return false;
  } finally {
    try { await fs.removeAsync(zipPath); } catch (e) { /* ignore */ }
  }

  await writeInstalledMelonVersion(gamePath, latestTag);

  api.dismissNotification('drova-melon-installing');
  api.sendNotification({
    type: 'success',
    message: isUpdate
      ? ('MelonLoader updated' + (latestTag ? ' to ' + latestTag : '') + '.')
      : 'MelonLoader installed for Drova.',
    displayMS: 5000,
  });
  if (!isUpdate) {
    await api.showDialog('info', 'First launch will be slow', {
      text:
        'MelonLoader has been installed. The first time you start Drova it may '
        + 'appear frozen for several minutes while MelonLoader generates assembly '
        + 'unhollower files in the game folder.\n\n'
        + 'This is normal — please do not close the game. Subsequent launches '
        + 'will start at normal speed.',
    }, [
      { label: 'Got it' },
    ]);
  }
  return true;
}

// Filesystem probe of the standard install location. No child process, so no
// spawn/timeout path can leave a promise hanging. Never throws.
async function isDotNet6DesktopInstalled() {
  const bases = [];
  const w64 = process.env.ProgramW6432;
  const pf = process.env['ProgramFiles'];
  if (w64) bases.push(w64);
  if (pf && pf !== w64) bases.push(pf);
  if (bases.length === 0) bases.push('C:\\Program Files');

  for (const base of bases) {
    const sharedDir = path.join(base, 'dotnet', 'shared', 'Microsoft.WindowsDesktop.App');
    let entries;
    try {
      entries = await fs.readdirAsync(sharedDir);
    } catch (err) {
      continue;
    }
    if (Array.isArray(entries) && entries.some(name => /^6\./.test(name))) {
      return true;
    }
  }
  return false;
}

async function ensureDotNet6(api) {
  // Windows-only probe: on other platforms Drova runs through Proton/Wine, where
  // the runtime lives inside the prefix and this check is meaningless.
  if (process.platform !== 'win32') return;

  let installed;
  try {
    installed = await isDotNet6DesktopInstalled();
  } catch (err) {
    log('warn', '[drova] .NET 6 detection failed', { err: err && err.message });
    return;
  }
  if (installed) return;

  log('info', '[drova] .NET 6 Desktop Runtime (x64) not found');
  let result;
  try {
    result = await api.showDialog('warning', '.NET 6 Desktop Runtime required', {
      text:
        'MelonLoader for Drova (an IL2CPP Unity game) needs the Microsoft '
        + '.NET 6 Desktop Runtime (x64) to run, and it does not appear to be '
        + 'installed. Without it Drova may crash or hang on the first launch '
        + 'after MelonLoader is installed.\n\n'
        + 'Install the ".NET Desktop Runtime 6.0.x" (x64) from Microsoft, then '
        + 'start Drova again.',
    }, [
      { label: 'Open download page' },
      { label: 'Continue anyway' },
    ]);
  } catch (err) {
    log('warn', '[drova] .NET 6 dialog failed', { err: err && err.message });
    return;
  }

  if (result && result.action === 'Open download page') {
    try {
      await util.opn(DOTNET6_DOWNLOAD_URL);
    } catch (err) {
      log('warn', '[drova] failed to open .NET 6 download page', { err: err && err.message });
    }
  }
}

async function ensureMelonLoader(api) {
  try {
    const state = api.getState();
    const discovery = state.settings.gameMode.discovered[GAME_ID];
    if (!discovery || !discovery.path) return;

    const gamePath = discovery.path;
    const release = await getLatestMelonRelease();
    const latestTag = release.tag;

    if (await isMelonLoaderInstalled(gamePath)) {
      const installedTag = await getInstalledMelonVersion(gamePath);
      log('info', '[drova] MelonLoader present', { installedTag, latestTag });

      await ensureDotNet6(api);

      if (!latestTag) return; // offline or rate-limited — skip silently
      if (!installedTag) {
        // Pre-existing install without our marker — record current as latest
        // so we only prompt on the next real release.
        await writeInstalledMelonVersion(gamePath, latestTag);
        return;
      }
      if (installedTag === latestTag) return;

      const result = await api.showDialog('question', 'MelonLoader update available', {
        text:
          'A newer MelonLoader version is available.\n\n'
          + 'Installed: ' + installedTag + '\n'
          + 'Latest:    ' + latestTag + '\n\n'
          + 'Do you want Vortex to download and install the update now? '
          + 'Existing mods, plugins and UserData will be preserved.',
      }, [
        { label: 'Later' },
        { label: 'Update' },
      ]);
      if (result.action === 'Update') {
        await installMelonLoader(api, gamePath, {
          isUpdate: true,
          latestTag,
          downloadUrl: release.downloadUrl,
          sha256: release.sha256,
        });
      }
      return;
    }

    const result = await api.showDialog('question', 'MelonLoader required', {
      text:
        'Drova mods need MelonLoader installed in the game folder. '
        + 'Do you want Vortex to download and install the latest MelonLoader now?\n\n'
        + 'Note: After installing MelonLoader, the first launch of Drova may '
        + 'appear frozen for several minutes while MelonLoader generates assembly '
        + 'unhollower files. This is normal — do not close the game. Subsequent '
        + 'launches will start normally.',
    }, [
      { label: 'Skip' },
      { label: 'Install' },
    ]);

    if (result.action === 'Install') {
      const ok = await installMelonLoader(api, gamePath, {
        isUpdate: false,
        latestTag,
        downloadUrl: release.downloadUrl,
        sha256: release.sha256,
      });
      if (ok) await ensureDotNet6(api);
    }
  } catch (err) {
    log('warn', '[drova] ensureMelonLoader failed', { err: err && err.message });
  }
}

// ---------------------------------------------------------------------------
// Installers
// ---------------------------------------------------------------------------

function archiveTopLevel(files) {
  const tops = new Set();
  for (const f of files) {
    const norm = f.replace(/\\/g, '/');
    const seg = norm.split('/')[0];
    if (seg) tops.add(seg.toLowerCase());
  }
  return tops;
}

// 1. Full MelonLoader pack: archive contains MelonLoader/, version.dll, Mods/,
//    UserData/, UserLibs/, or Plugins/ at root. Install to game root.
function testMelonPack(files, gameId) {
  if (gameId !== GAME_ID) return Promise.resolve({ supported: false, requiredFiles: [] });
  const tops = archiveTopLevel(files);
  const looksLikePack =
    tops.has('melonloader') || tops.has('version.dll') || tops.has('mods')
    || tops.has('userdata') || tops.has('userlibs') || tops.has('plugins');
  log('info', '[drova] testMelonPack', { gameId, tops: [...tops], supported: looksLikePack });
  return Promise.resolve({ supported: looksLikePack, requiredFiles: [] });
}

function installMelonPack(files) {
  const instructions = files
    .filter(f => !f.endsWith(path.sep) && !f.endsWith('/'))
    .map(source => ({ type: 'copy', source, destination: source }));
  return Promise.resolve({ instructions });
}

// 2. Translation: archive contains .loc files. Strip wrappers above the
//    locale folder, preserve locale + subfolders, install under Localization/.
const LOCALE_SEG_RE = /^[a-z]{2}([-_][a-z0-9]{2,4})?$/i;

function stripAboveLocale(filePath) {
  const segs = filePath.replace(/\\/g, '/').split('/');
  for (let i = 0; i < segs.length - 1; i++) {
    if (LOCALE_SEG_RE.test(segs[i])) {
      return segs.slice(i).join('/');
    }
  }
  return null;
}

function testTranslation(files, gameId) {
  if (gameId !== GAME_ID) return Promise.resolve({ supported: false, requiredFiles: [] });
  const lower = files.map(f => f.toLowerCase());
  const hasLoc = lower.some(f => f.endsWith('.loc'));
  log('info', '[drova] testTranslation', { gameId, sampleFiles: files.slice(0, 5), hasLoc });
  return Promise.resolve({ supported: hasLoc, requiredFiles: [] });
}

function installTranslation(files) {
  const locFiles = files.filter(f => f.toLowerCase().endsWith('.loc'));
  const instructions = locFiles.map(source => {
    const rel = stripAboveLocale(source);
    const destination = rel
      ? path.join(TRANSLATIONS_DIR, rel)
      : path.join(TRANSLATIONS_DIR, path.basename(source));
    return { type: 'copy', source, destination };
  });
  log('info', '[drova] installTranslation summary', {
    inputCount: files.length,
    locCount: locFiles.length,
    sampleInputs: files.slice(0, 8),
    sampleOutputs: instructions.slice(0, 8).map(i => ({ src: i.source, dst: i.destination })),
  });
  return Promise.resolve({ instructions });
}

// 3. Simple DLL mod: archive contains .dll files → Mods/.
function testSimpleDll(files, gameId) {
  if (gameId !== GAME_ID) return Promise.resolve({ supported: false, requiredFiles: [] });
  const hasDll = files.some(f => f.toLowerCase().endsWith('.dll'));
  log('info', '[drova] testSimpleDll', { gameId, hasDll });
  return Promise.resolve({ supported: hasDll, requiredFiles: [] });
}

function installSimpleDll(files) {
  const instructions = files
    .filter(f => !f.endsWith(path.sep) && !f.endsWith('/'))
    .map(source => ({
      type: 'copy',
      source,
      destination: path.join(MODS_DIR, source),
    }));
  return Promise.resolve({ instructions });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(context) {
  context.registerGame({
    id: GAME_ID,
    name: 'Drova - Forsaken Kin',
    mergeMods: true,
    queryPath: findGame,
    supportedTools: [],
    queryModPath: modsRelPath,
    logo: 'gameart.jpeg',
    executable: () => GAME_EXE,
    requiredFiles: [GAME_EXE],
    setup: () => ensureMelonLoader(context.api),
    environment: { SteamAPPId: STEAM_APP_ID },
    details: {
      steamAppId: parseInt(STEAM_APP_ID, 10),
      gogAppId: GOG_APP_ID,
      nexusPageId: NEXUS_SLUG,
    },
  });

  // Lower priority number wins. All well below Vortex's BasicInstaller (~1000).
  context.registerInstaller('drova-translation', 15, testTranslation, installTranslation);
  context.registerInstaller('drova-melon-pack', 20, testMelonPack, installMelonPack);
  context.registerInstaller('drova-simple-dll', 25, testSimpleDll, installSimpleDll);

  context.once(() => {
    context.api.events.on('gamemode-activated', (gameId) => {
      if (gameId === GAME_ID) {
        ensureMelonLoader(context.api).catch(() => {});
      }
    });
  });

  return true;
}

module.exports = { default: main };
