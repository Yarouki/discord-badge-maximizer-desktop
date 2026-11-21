import { registerFonts } from './fonts.js';
import { createPicker } from './picker.js';
import { buildScene } from './scene.js';
import {
  MAX_HOURS_PER_GAME, SECTIONS, accountRows, accountsSignature, altHint, badgeView, claimEtaMs, claimStartAction, claimSummary, clamp, clock,
  countOf, etaText, firstLetter, fmt, isCurrent, modeChangeAction, parseGamesInput, smooth, stamp, startResultAction,
  stepsDone, streamedHours,
} from './logic.js';

const BOOT_MAX_MS = 6000;
function hideBoot() {
  document.getElementById('boot')?.classList.add('done');
  document.body.removeAttribute('aria-busy');
  for (const node of document.querySelectorAll('.topbar, .sidenav, main')) node.inert = false;
}
setTimeout(hideBoot, BOOT_MAX_MS);

registerFonts();

const api = window.api;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const S = {
  account: 'out',
  user: null,
  catalog: 0,
  batchSize: 50,
  totals: { games: 0, gameHours: 0, streamHours: 0 },
  tiers: { gametime: null, variety: null, stream: null },
  earned: {},
  games: { status: 'idle', count: 100, all: false, hours: 50, batch: 0, total: 0, failed: 0, game: '', startedAt: 0, summary: null, run: 0 },
  stream: { status: 'off', step: 0, mode: 'video', liveMode: 'video', startedAt: 0, viewers: 0, tick: 0, restartAs: null, run: 0, counted: 0, lastChannel: '', accepted: false, endedHours: 0 },
  alt: { account: 'out', name: '', autoWatch: true, status: 'idle' },
  accounts: { mainId: null, altId: null, accounts: [] },
  menuOpen: false,
  confirmSwitch: null,
  backendDown: '',
  connecting: 'login',
};
let fx = null;

const LOG_MAX_LINES = 300;
const logLines = [];
function log(msg, cls = '', problem = cls === 'pink', speak = true) {
  const ol = $('#log');
  const li = document.createElement('li');
  const t = document.createElement('time');
  t.textContent = stamp(new Date());
  const span = document.createElement('span');
  span.textContent = msg;
  if (cls) span.className = cls;
  li.append(t, span);
  ol.prepend(li);
  logLines.unshift(`${t.textContent}  ${msg}`);
  while (ol.children.length > LOG_MAX_LINES) { ol.lastChild.remove(); logLines.pop(); }
  if (speak) announce(msg, problem);
}
const ANNOUNCE_KEEP = 3;
function announce(msg, urgent = false) {
  const region = $(urgent ? '#srAlert' : '#srStatus');
  if (!region) return;
  region.append(el('div', '', msg));
  while (region.children.length > ANNOUNCE_KEEP) region.firstElementChild.remove();
}
const errorText = (res, fallback) => (res && res.error) || fallback;
function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}
let lastRun = 0;
const nextRun = () => ++lastRun;
const failed = (err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) });

function applyLogin(res) {
  if (S.user && S.user.id !== res.user.id) resetClaimPanel();
  if (S.user?.id !== res.user.id) {
    S.tiers = { gametime: null, variety: null, stream: null };
    S.earned = {};
    chosenServer = ''; S.stream.lastChannel = '';
  }
  S.account = 'in';
  S.backendDown = '';
  S.user = { id: res.user.id, name: res.user.displayName || res.user.username || 'Discord user' };
  S.catalog = res.catalog_size || 0;
  S.batchSize = res.batch_size || S.batchSize;
  S.totals = { ...S.totals, ...res.totals };
  S.stream.endedHours = 0;
  fx?.connected();
  updateMath(false);
  render();
  if (!S.alt.autoWatch) api.setAutoWatch(false).catch(failed);
  refreshBadges();
  loadServers();
}

let chosenServer = '';
const serverPicker = createPicker($('#sServerPicker'), {
  kind: 'server',
  onChange: (id) => { clearStreamError('#sServer', '#sServerErr'); chosenServer = id; S.stream.lastChannel = ''; loadChannels(); },
});
const channelPicker = createPicker($('#sChannelPicker'), {
  kind: 'voice',
  onChange: (id) => { clearStreamError('#sChannel', '#sChannelErr'); S.stream.lastChannel = id; },
});
function clearStreamError(field, err) {
  showError($(err), false, '');
  $(field).setAttribute('aria-invalid', 'false');
}
function showError(node, show, text) {
  node.hidden = !show;
  setText(node, show ? text : '');
}
let serversLoad = 0;
let channelsLoad = 0;
let serverListNote = '';
async function loadServers() {
  if (S.account !== 'in') return;
  const n = ++serversLoad;
  channelsLoad++;
  serverListNote = '';
  serverPicker.setStatus('Loading');
  channelPicker.setStatus('Pick a server first');
  setPickerNote('');
  const res = await api.voiceServers().catch(failed);
  if (n !== serversLoad) return;
  const servers = res.ok && Array.isArray(res.servers) ? res.servers : null;
  if (servers && res.altProblem) {
    serverListNote = res.altProblem;
    log(res.altProblem, 'pink');
    setPickerNote(serverListNote);
  }
  if (!servers) {
    serverPicker.setStatus("Couldn't load");
    setPickerNote("Your servers couldn't be loaded. Check your connection, then restart the app to try again.");
    log(errorText(res, "Couldn't load your servers."), 'pink');
    return;
  }
  if (!servers.length) {
    serverPicker.setStatus('None found');
    setPickerNote(res.withAlt
      ? 'No server has both your accounts. Join one server with the main and the alt account, then come back.'
      : 'This account is not on any server. Join one in Discord, then come back.');
    return;
  }
  serverPicker.setItems(servers, chosenServer || res.lastGuildId);
  if (serverPicker.value !== chosenServer) S.stream.lastChannel = '';
  chosenServer = serverPicker.value;
  if (!S.stream.lastChannel && chosenServer === res.lastGuildId) S.stream.lastChannel = res.lastChannelId || '';
  await loadChannels();
}
let serversStale = false;
function reloadServers() {
  serversStale = S.stream.status !== 'off';
  if (!serversStale) loadServers();
}
async function loadChannels() {
  const n = ++channelsLoad;
  const gid = serverPicker.value;
  if (!gid) { channelPicker.setStatus('Pick a server first'); return; }
  channelPicker.setStatus('Loading');
  setPickerNote(serverListNote);
  const res = await api.voiceChannels(gid).catch(failed);
  if (n !== channelsLoad) return;
  const channels = res.ok && Array.isArray(res.channels) ? res.channels : null;
  if (!channels) {
    channelPicker.setStatus("Couldn't load");
    setPickerNote("The voice channels of this server couldn't be loaded. Pick the server again to retry.");
    log(errorText(res, "Couldn't load the voice channels."), 'pink');
    return;
  }
  if (!channels.length) {
    channelPicker.setStatus('None here');
    setPickerNote('This server has no voice channel you can see. Pick another server.');
    return;
  }
  channelPicker.setItems(channels, S.stream.lastChannel);
  S.stream.lastChannel = channelPicker.value;
}
function setPickerNote(text) {
  const note = $('#sPickerNote');
  setText(note, text);
  note.hidden = !text;
}
function resetClaimPanel() {
  if (S.games.status === 'done') S.games.status = 'idle';
  S.games.summary = null;
}
function setLoggedOut() {
  if (S.games.status === 'running') stopClaim(true);
  if (S.stream.status !== 'off') stopStream(true);
  resetClaimPanel();
  S.account = 'out';
  S.user = null;
  S.tiers = { gametime: null, variety: null, stream: null };
  S.earned = {};
  S.stream.endedHours = 0;
  S.alt.account = 'out'; S.alt.name = ''; S.alt.status = 'idle';
  S.confirmSwitch = null;
  serversLoad++; channelsLoad++;
  chosenServer = ''; S.stream.lastChannel = ''; serverListNote = ''; serversStale = false;
  serverPicker.setStatus('Log in first');
  channelPicker.setStatus('Pick a server first');
  setPickerNote('');
  fx?.disconnected();
}
function applyAccounts(res) {
  if (!res) return;
  if (res.accounts) S.accounts = res.accounts;
  const note = res.warning || (res.ok && res.error);
  if (note) log(note, 'pink');
  const loggedIn = Boolean(res.login && res.login.ok);
  if (loggedIn) applyLogin(res.login);
  if (res.alt !== undefined) {
    if (res.alt) { S.alt.account = 'in'; S.alt.name = res.alt.username || 'Alt account'; }
    else { S.alt.account = 'out'; S.alt.name = ''; S.alt.status = 'idle'; }
    if (!loggedIn) reloadServers();
  }
  if (!S.accounts.mainId && S.account !== 'out') setLoggedOut();
  if (S.account === 'connecting' && !loggedIn) settleMain();
  if (S.alt.account === 'connecting' && res.alt === undefined) S.alt.account = S.alt.name ? 'in' : 'out';
  render();
}
function settleMain() {
  S.account = S.user ? 'in' : 'out';
  if (S.user) fx?.idle();
  else fx?.disconnected();
  if (S.user) refreshBadges();
}
async function login() {
  if (S.account !== 'out') return;
  S.account = 'connecting';
  S.connecting = 'login';
  log('Opened the Discord login window');
  fx?.connecting();
  render();
  const res = await api.accountLogin('main').catch(failed);
  if (!res.ok) log(errorText(res, 'Login cancelled.'), 'pink');
  applyAccounts(res);
}
const BACKEND_STOPPED = /backend (stopped|is not running)/i;
async function restoreLogin() {
  S.account = 'connecting';
  S.connecting = 'restore';
  render();
  const res = await api.restoreAccounts().catch(failed);
  if (!res.ok) {
    if (!res.error || res.nothingSaved) log('Ready. Log in with Discord to start.');
    else if (!BACKEND_STOPPED.test(res.error)) log(`Couldn't log back in: ${res.error}`, 'pink');
  }
  applyAccounts(res);
}
function keepAccountFocus() {
  focusIfLost('#acctMenuBtn');
  focusIfLost('#barAcct [data-action="login"]');
}
async function logout() {
  S.menuOpen = false;
  setLoggedOut();
  render();
  keepAccountFocus();
  const res = await api.logout().catch(failed);
  if (!res.ok) log(errorText(res, "Couldn't log out."), 'pink');
  applyAccounts(res);
  keepAccountFocus();
  if (!res.ok && S.accounts.mainId) restoreLogin();
}
async function addAccount() {
  S.menuOpen = false;
  render();
  keepAccountFocus();
  log('Opened the Discord login window for another account');
  const res = await api.addAccount().catch(failed);
  if (!res.ok) log(errorText(res, 'Login cancelled.'), 'pink');
  applyAccounts(res);
  keepAccountFocus();
}
async function useAccount(id, role) {
  const busy = S.games.status === 'running' || S.stream.status !== 'off';
  if (role === 'main' && busy && S.confirmSwitch !== id) {
    S.confirmSwitch = id;
    render();
    return;
  }
  S.confirmSwitch = null;
  S.menuOpen = false;
  if (role === 'main') {
    if (S.games.status === 'running') stopClaim(true);
    if (S.stream.status !== 'off') stopStream(true);
    S.account = 'connecting';
    S.connecting = 'switch';
    fx?.connecting();
  } else {
    S.alt.account = 'connecting';
  }
  render();
  keepAccountFocus();
  const res = await api.useAccount(id, role).catch(failed);
  if (!res.ok) log(errorText(res, "Couldn't switch accounts."), 'pink');
  applyAccounts(res);
  keepAccountFocus();
}
async function removeAccount(id) {
  const wasMain = id === S.accounts.mainId;
  if (wasMain) setLoggedOut();
  render();
  keepAccountFocus();
  const res = await api.removeAccount(id).catch(failed);
  if (!res.ok) log(errorText(res, "Couldn't remove the account."), 'pink');
  applyAccounts(res);
  keepAccountFocus();
  if (!res.ok && wasMain) restoreLogin();
}

function focusIfLost(selector) {
  const active = document.activeElement;
  const lost = !active || active === document.body || !active.isConnected || active.closest('[hidden]') !== null;
  const target = $(selector);
  if (lost && target && !target.closest('[hidden]') && !target.closest('[inert]')) target.focus({ preventScroll: true });
}

function readGames() {
  return parseGamesInput({ countText: $('#gCount').value, hoursText: $('#gHours').value, all: S.games.all, catalog: S.catalog });
}
function updateMath(showErrors = false, forceCountError = false) {
  const { count, hours, countOk, hoursOk } = readGames();
  const showCount = (!countOk && showErrors) || forceCountError;
  const showHours = !hoursOk && showErrors;
  $('#gCount').setAttribute('aria-invalid', String(showCount));
  $('#gHours').setAttribute('aria-invalid', String(showHours));
  let countText = `Enter a whole number of games from 1 to ${fmt(S.catalog)}.`;
  if (!S.catalog) countText = S.account === 'in' ? "The detectable games list didn't load. Restart the app to try again." : 'Log in first to load the detectable games.';
  showError($('#gCountErr'), showCount, countText);
  showError($('#gHoursErr'), showHours, `Enter a whole number of hours from 1 to ${fmt(MAX_HOURS_PER_GAME)}.`);
  if (countOk && hoursOk) {
    setText($('#gTotal'), `${fmt(count * hours)} h`);
    setText($('#gEq'), `${countOf(count, 'game')} × ${fmt(hours)} h`);
  } else {
    setText($('#gTotal'), '0 h');
    setText($('#gEq'), 'Check the numbers above');
  }
  return countOk && hoursOk;
}
const CLAIM_START_RETRIES = 40;
async function startClaim(attempt = 0) {
  const g = S.games;
  if (attempt === 0) {
    if (S.account !== 'in') { login(); return; }
    if (!S.catalog) { updateMath(true, true); return; }
    if (!updateMath(true)) { (readGames().countOk ? $('#gHours') : $('#gCount')).focus(); return; }
    const { count, hours } = readGames();
    Object.assign(g, {
      status: 'running', count, hours, batch: 0, failed: 0, total: Math.ceil(count / S.batchSize),
      game: '', startedAt: performance.now(), summary: null, run: nextRun(),
    });
    log(`Started claiming ${countOf(count, 'game')} at ${fmt(hours)} h each`, 'gold');
    fx?.claimStart();
    render();
    focusIfLost('#gStop');
  }
  const run = g.run;
  const res = await api.startClaim({ games: g.count, hours: g.hours, all: g.all, run }).catch(failed);
  const action = claimStartAction({ ok: res.ok, error: res.error, sameRun: g.run === run, running: g.status === 'running', attempt, maxAttempts: CLAIM_START_RETRIES });
  if (action === 'accepted' || action === 'ignore') return;
  if (action === 'stop') { api.stopClaim(run).catch(failed); return; }
  if (action === 'retry') {
    setTimeout(() => { if (g.run === run && g.status === 'running') startClaim(attempt + 1); }, START_RETRY_MS);
    return;
  }
  g.status = 'idle';
  fx?.claimStop();
  log(errorText(res, 'The claim did not start.'), 'pink');
  render();
  focusIfLost('#gStart');
}
function onClaimProgress(d) {
  const g = S.games;
  if (g.status !== 'running' || !isCurrent(d, g.run)) return;
  Object.assign(g, { batch: d.batch, total: d.total, failed: d.failed || 0, game: d.game || '' });
  fx?.batchSent();
  render();
}
function onClaimDone(d) {
  const g = S.games;
  if (d.stopped || g.status !== 'running' || !isCurrent(d, g.run)) { refreshBadges(); return; }
  const summary = d.error ? { kind: 'failed', text: `The claim stopped. ${d.error}` } : claimSummary(d, g.hours, g.total);
  if (summary.kind === 'failed') {
    g.status = 'idle';
    fx?.claimStop();
    log(summary.text, 'pink');
  } else {
    g.status = 'done';
    g.batch = g.total;
    g.summary = summary;
    log(summary.text, summary.kind === 'done' ? 'gold' : 'pink');
    fx?.claimDone();
  }
  render();
  focusIfLost(g.status === 'done' ? '#gAgain' : '#gStart');
  refreshBadges();
}
function stopClaim(silent = false) {
  const g = S.games;
  if (!silent) log(`Stopped claiming after batch ${g.batch} of ${g.total}`);
  g.status = 'idle';
  fx?.claimStop();
  render();
  if (!silent) focusIfLost('#gStart');
  api.stopClaim(g.run).catch(failed).then((res) => { if (!res.ok) log(errorText(res, "The claim couldn't be stopped."), 'pink'); });
}

function validId(v) { return /^\d{17,20}$/.test(v); }
function checkStreamInputs() {
  const sOk = validId(serverPicker.value), cOk = validId(channelPicker.value);
  serverPicker.setInvalid(!sOk); channelPicker.setInvalid(!cOk);
  showError($('#sServerErr'), !sOk, 'Pick a server. With an alt connected, only servers both accounts are on show up.');
  showError($('#sChannelErr'), sOk && !cOk, 'Pick a voice channel.');
  if (!sOk) serverPicker.focus(); else if (!cOk) channelPicker.focus();
  return sOk && cOk;
}
const START_RETRIES = 10;
const START_RETRY_MS = 400;
async function startStream(attempt = 0) {
  if (S.account !== 'in') { login(); return; }
  const st = S.stream;
  if (attempt === 0) {
    if (!checkStreamInputs()) return;
    st.status = 'connecting'; st.step = 0; st.run = nextRun(); st.liveMode = st.mode; st.accepted = false;
    log('Starting stream');
    fx?.streamConnecting();
    render();
  }
  const run = st.run;
  const mode = st.liveMode;
  const res = await api.startStream({ serverId: serverPicker.value, channelId: channelPicker.value, mode, run }).catch(failed);
  const action = startResultAction({ ok: res.ok, error: res.error, sameRun: st.run === run, status: st.status, attempt, maxAttempts: START_RETRIES });
  if (action === 'ignore') return;
  if (action === 'stop') { api.stopStream(run).catch(failed); return; }
  if (action === 'accepted') {
    st.accepted = true;
    if (st.status === 'connecting' && st.restartAs === null && st.liveMode !== mode) {
      const wanted = st.liveMode;
      st.liveMode = mode;
      switchMode(wanted);
    }
    return;
  }
  if (action === 'retry') {
    setTimeout(() => { if (st.run === run && st.status === 'connecting') startStream(attempt + 1); }, START_RETRY_MS);
    return;
  }
  if (action === 'giveUp') api.stopStream().catch(failed);
  log(errorText(res, 'The stream did not start.'), 'pink');
  resetStream();
  focusIfLost('#sStart');
}
function onStreamStep(d) {
  const st = S.stream;
  if (st.status !== 'connecting' || !isCurrent(d, st.run)) return;
  st.step = stepsDone(d.step, st.step);
  render();
}
function goLive(d) {
  const st = S.stream;
  if (st.status !== 'connecting' || !isCurrent(d, st.run)) return;
  st.status = 'live'; st.step = 4;
  st.startedAt = performance.now();
  st.viewers = 0;
  if (d && (d.mode === 'video' || d.mode === 'silent')) st.liveMode = d.mode;
  log(`Stream is live in ${channelPicker.name || 'the voice channel'}`, 'pink', false);
  if (d && d.fallback) {
    log(d.fallback, 'pink');
    st.mode = st.liveMode;
    const radio = $(`input[name="mode"][value="${st.mode}"]`);
    if (radio) radio.checked = true;
  }
  if (st.restartAs === null && st.mode !== st.liveMode) switchMode(st.mode);
  fx?.streamLive();
  clearInterval(st.tick);
  st.tick = setInterval(liveTick, 1000);
  liveTick();
  render();
}
function liveTick() {
  const st = S.stream;
  if (st.status !== 'live') return;
  const t = clock(performance.now() - st.startedAt);
  $('#sTimer').textContent = t;
  $('#taskLiveText').textContent = t;
}
function resetStream() {
  const st = S.stream;
  clearInterval(st.tick);
  st.status = 'off'; st.step = 0; st.viewers = 0;
  st.restartAs = null;
  st.accepted = false;
  S.alt.status = 'idle';
  st.counted = 0;
  $('#sTimer').textContent = '00:00:00';
  fx?.streamOff();
  render();
  if (serversStale) setTimeout(() => { if (serversStale && S.stream.status === 'off' && S.account === 'in') reloadServers(); }, 0);
}
function switchMode(mode) {
  log(mode === 'video' ? 'Switching the stream to video, reconnecting' : 'Switching the stream to silent keepalive, reconnecting', 'pink', false);
  S.stream.restartAs = mode;
  api.stopStream(S.stream.run).catch(failed);
}
function onStreamEnded(d) {
  const st = S.stream;
  st.endedHours += Number(d && d.hours) || 0;
  if (!isCurrent(d, st.run)) { refreshBadges(); return; }
  if (st.restartAs !== null) {
    resetStream();
    startStream();
    refreshBadges();
    return;
  }
  if (st.status !== 'off') {
    const liveMs = st.status === 'live' ? performance.now() - st.startedAt : 0;
    if (d.error) log(`The stream ended. ${d.error}`, 'pink');
    else log(`Stream stopped after ${clock(liveMs)}`);
    resetStream();
    focusIfLost('#sStart');
  }
  refreshBadges();
}
function stopStream(silent = false) {
  const st = S.stream;
  if (!silent) log(st.status === 'live' ? `Stream stopped after ${clock(performance.now() - st.startedAt)}` : 'Stream start cancelled');
  resetStream();
  api.stopStream(st.run).catch(failed).then((res) => { if (!res.ok) log(errorText(res, "The stream couldn't be stopped."), 'pink'); });
}

async function altLogin() {
  if (S.alt.account !== 'out') return;
  S.alt.account = 'connecting';
  log('Opened the Discord login window for the alt account');
  render();
  const res = await api.accountLogin('alt').catch(failed);
  if (!res.ok) log(errorText(res, 'Alt login cancelled.'), 'pink');
  applyAccounts(res);
}
async function altLogout() {
  const before = { ...S.alt };
  S.alt.account = 'out';
  S.alt.status = 'idle';
  S.alt.name = '';
  render();
  const res = await api.clearAlt().catch(failed);
  if (!res.ok) {
    log(errorText(res, "Couldn't disconnect the alt account."), 'pink');
    Object.assign(S.alt, before);
  }
  applyAccounts(res);
}
async function forgetDroppedAlt() {
  S.alt.account = 'out'; S.alt.name = ''; S.alt.status = 'idle';
  render();
  const res = await api.clearAlt().catch(failed);
  if (!res.ok) log(errorText(res, "Couldn't forget the alt account."), 'pink');
  applyAccounts(res);
}
function onAltStatus(d) {
  if (d && d.error) log(d.error, 'pink');
  if (d && d.dropped && S.alt.account === 'in') { forgetDroppedAlt(); return; }
  if (S.alt.account !== 'in' || !isCurrent(d, S.stream.run)) return;
  const next = S.stream.status === 'live' ? d.status : 'idle';
  if (next === S.alt.status) return;
  if (next === 'joined') log('Alt viewer joined the channel');
  if (next === 'watching') log('Alt viewer is watching your stream');
  if (next === 'idle' && S.alt.status !== 'idle') log('Alt viewer left the channel');
  S.alt.status = next;
  render();
}

async function refreshBadges() {
  if (S.account !== 'in') return;
  const userId = S.user.id;
  const endedBefore = S.stream.endedHours;
  const res = await api.badges().catch(failed);
  if (S.account !== 'in' || S.user.id !== userId) return;
  if (res.totals) {
    S.totals = { ...S.totals, ...res.totals };
    S.stream.endedHours = Math.max(0, S.stream.endedHours - endedBefore);
  }
  if (res.ok) { S.tiers = res.tiers || S.tiers; S.earned = res.earned || {}; }
  else if (res.error) log(res.error, 'pink');
  renderBadges();
}

function showBy(attr, value) {
  $$(`[${attr}]`).forEach((node) => { node.hidden = node.getAttribute(attr) !== value; });
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const CONNECTING_TEXT = {
  login: ['Waiting for Discord', 'Waiting for you to finish logging in to Discord'],
  restore: ['Checking your saved login', 'Checking your saved login'],
  switch: ['Switching accounts', 'Switching accounts'],
};
function render() {
  $$('#barAcct [data-show], #heroAuth [data-show]').forEach((node) => { node.hidden = node.dataset.show !== S.account; });
  $$('[data-auth]').forEach((node) => { node.hidden = S.account === 'in'; });
  const name = S.user ? S.user.name : '';
  const initial = firstLetter(name);
  $$('#acctMenuBtn .avatar, #heroAuth .auth-card .avatar').forEach((node) => setText(node, initial));
  setText($('#acctMenuBtn .chip-name'), name);
  setText($('#acctMenuBtn .chip-id'), S.user ? S.user.id : '');
  setText($('#heroAuth .auth-card .name'), name);
  setText($('#heroAuth .auth-card .meta'), S.user ? `User ID ${S.user.id}` : '');
  setText($('#barConnecting'), CONNECTING_TEXT[S.connecting][0]);
  setText($('#heroConnecting'), CONNECTING_TEXT[S.connecting][1]);
  $('#backendDown').hidden = !(S.backendDown && S.account === 'out');
  setText($('#backendDownText'), S.backendDown);

  renderGames();
  renderStream();
  renderAlt(name);
  fx?.sync();
  renderBadges();
  renderAccounts();
}
function renderGames() {
  const g = S.games;
  $('#gamesForm').hidden = g.status !== 'idle';
  $('#gamesRun').hidden = g.status !== 'running';
  $('#gamesDone').hidden = g.status !== 'done';
  $('#gStart').disabled = S.account !== 'in';
  $('#gCount').disabled = g.all;
  $('#gCount').max = String(Math.max(1, S.catalog));
  setText($('#gAllText'), S.catalog ? `Claim all ${fmt(S.catalog)} detectable games` : 'Claim all detectable games');
  if (g.all) $('#gCount').value = S.catalog;
  $('#gAll').setAttribute('aria-checked', String(g.all));
  if (g.status === 'running') {
    const pct = g.total ? Math.round((g.batch / g.total) * 100) : 0;
    const eta = etaText(claimEtaMs({ batch: g.batch, total: g.total, elapsedMs: performance.now() - g.startedAt }));
    setText($('#gBatch'), `Batch ${fmt(g.batch)} of ${fmt(g.total)}`);
    setText($('#gPct'), eta ? `${pct}%, ${eta}` : `${pct}%`);
    $('#gProg').setAttribute('aria-valuenow', String(pct));
    $('#gProg span').style.width = `${pct}%`;
    const gameEl = $('#gGame');
    if (!g.game) {
      delete gameEl.dataset.game;
      setText(gameEl, 'Preparing the first batch');
    } else if (gameEl.dataset.game !== g.game) {
      gameEl.dataset.game = g.game;
      gameEl.replaceChildren('Now sending ', el('b', '', g.game));
    }
    $('#gFailed').hidden = !g.failed;
    setText($('#gFailed'), g.failed === 1 ? '1 batch failed so far and will not be counted' : `${fmt(g.failed)} batches failed so far and will not be counted`);
  }
  if (g.status === 'done' && g.summary) {
    setText($('#gDoneText'), g.summary.text);
    $('#gDoneBar').style.width = `${Math.round((g.summary.share ?? 1) * 100)}%`;
  }
  $('#taskGames').hidden = g.status !== 'running';
  setText($('#taskGamesText'), `Claiming, batch ${fmt(g.batch)} of ${fmt(g.total)}`);
}
function renderStream() {
  const st = S.stream;
  const live = st.status === 'live';
  const sBtn = $('#sStart');
  setText(sBtn, st.status === 'off' ? 'Start stream' : (st.status === 'connecting' ? 'Cancel' : 'Stop stream'));
  sBtn.className = st.status === 'off' ? 'btn btn-fuchsia' : 'btn btn-quiet';
  sBtn.disabled = S.account !== 'in';
  serverPicker.disabled = st.status !== 'off' || S.account !== 'in';
  channelPicker.disabled = st.status !== 'off' || S.account !== 'in';
  $$('#steps li').forEach((li, i) => {
    const done = st.step > i;
    const now = st.status === 'connecting' && st.step === i;
    li.classList.toggle('on', done);
    li.classList.toggle('now', now);
    setText(li.querySelector('.sr-only'), done ? ', done' : (now ? ', in progress' : ', waiting'));
  });
  $('#liveTag').classList.toggle('off', !live);
  setText($('#liveState'), live ? 'Stream is live.' : (st.status === 'connecting' ? 'Stream is connecting.' : 'Stream is off.'));
  setText($('#sViewers'), String(st.viewers));
  $('#watchHint').hidden = !(live && st.viewers === 0);
  $('#taskLive').hidden = !live;
}
function renderAlt(mainName) {
  const a = S.alt;
  const live = S.stream.status === 'live';
  showBy('data-alt', a.account);
  $('#autoWatch').setAttribute('aria-checked', String(a.autoWatch));
  for (const [selector, status] of [['#stIdle', 'idle'], ['#stJoined', 'joined'], ['#stWatching', 'watching']]) {
    const node = $(selector);
    node.classList.toggle('on', a.status === status);
    if (a.status === status) node.setAttribute('aria-current', 'true');
    else node.removeAttribute('aria-current');
  }
  setText($('#altHint'), altHint({ account: a.account, autoWatch: a.autoWatch, live, status: a.status }));
  $('#taskAlt').hidden = a.status !== 'watching';
  setText($('.alt-acct .avatar.alt'), firstLetter(a.name));
  setText($('.alt-acct .chip-name'), a.name);
  setText($('#orbMainLabel .oname'), mainName || 'Your account');
  setText($('#orbAltLabel .oname'), a.account === 'in' ? a.name : 'No alt yet');
  let altRole = 'Connect one on the left';
  if (a.account === 'in') altRole = a.status === 'watching' ? 'Alt account, watching' : (a.status === 'joined' ? 'Alt account, in channel' : 'Alt account, idle');
  setText($('#orbAltLabel .orole'), altRole);
  setText($('#orbMainLabel .orole'), live ? 'Main account, live' : 'Main account');
}
function accountRowEl(row) {
  const node = el('div', 'acct-row');
  const avatar = el('div', `avatar${row.isAlt ? ' alt' : ''}`, row.initial);
  avatar.setAttribute('aria-hidden', 'true');
  const who = el('div', 'acct-who');
  who.append(el('span', 'chip-name', row.name));
  if (row.isMain) who.append(el('span', 'acct-tag main', 'Main'));
  if (row.isAlt) who.append(el('span', 'acct-tag alt', 'Alt'));
  const box = el('div', 'acct-actions');
  for (const a of row.actions) {
    const b = el('button', `btn ${a.primary ? 'btn-primary' : 'btn-quiet'} btn-sm`, a.label);
    b.type = 'button';
    b.dataset.action = a.action;
    b.dataset.id = row.id;
    if (a.role) b.dataset.role = a.role;
    b.setAttribute('aria-label', `${a.label}, ${row.name}`);
    box.append(b);
  }
  node.append(avatar, who, box);
  return node;
}
const ACCOUNT_LISTS = '#acctMenuRows, #heroAccounts, #altAccounts';
let accountsShown = '';
function renderAccounts() {
  const view = {
    accounts: S.accounts.accounts, mainId: S.accounts.mainId, altId: S.accounts.altId,
    loggedIn: S.account === 'in', confirmSwitch: S.confirmSwitch,
  };
  const rows = accountRows(view);
  const menuOpen = S.menuOpen && S.account === 'in';
  $('#acctMenu').hidden = !menuOpen;
  $('#acctMenuBtn').setAttribute('aria-expanded', String(menuOpen));
  $('#acctMenuLogout').hidden = !view.mainId;
  $('#heroAccounts').hidden = S.account === 'connecting' || (S.account === 'out' && rows.hero.rows.length === 0);
  $('#altAccounts').hidden = S.alt.account !== 'out' || rows.alt.length === 0 || S.account !== 'in';
  const signature = accountsSignature(view);
  if (signature === accountsShown) return;
  accountsShown = signature;
  const focused = document.activeElement && document.activeElement.closest(ACCOUNT_LISTS) ? document.activeElement : null;
  const key = focused && { list: focused.closest(ACCOUNT_LISTS).id, action: focused.dataset.action, id: focused.dataset.id, role: focused.dataset.role || '' };
  $('#acctMenuRows').replaceChildren(...rows.menu.map(accountRowEl));
  const heroExtra = [];
  if (view.loggedIn) {
    const add = el('button', 'btn btn-quiet btn-sm', 'Add account');
    add.type = 'button';
    add.dataset.action = 'addAccount';
    heroExtra.push(add);
  }
  const scrollBox = (list) => { const box = el('div', 'acct-scroll'); box.append(...list.map(accountRowEl)); return box; };
  $('#heroAccounts').replaceChildren(el('div', 'acct-list-label', rows.hero.label), scrollBox(rows.hero.rows), ...heroExtra);
  $('#altAccounts').replaceChildren(el('div', 'acct-list-label', 'Or use a saved account'), scrollBox(rows.alt));
  if (key) refocusAccountButton(key);
}
function refocusAccountButton(key) {
  const list = document.getElementById(key.list);
  const buttons = [...list.querySelectorAll('button')];
  const same = buttons.find((b) => b.dataset.action === key.action && b.dataset.id === key.id && (b.dataset.role || '') === key.role);
  const target = same || buttons[0] || (key.list === 'acctMenuRows' ? $('#acctMenuBtn') : null);
  if (target && !target.closest('[hidden]')) target.focus({ preventScroll: true });
}

const shownStreamHours = () => streamedHours({
  savedHours: S.totals.streamHours, live: S.stream.status === 'live', countedSeconds: S.stream.counted, endedHours: S.stream.endedHours,
});
const BADGE_LABELS = [['#bl0', 'gametime'], ['#bl1', 'variety'], ['#bl2', 'stream']];
const BADGE_ICON_HOST = 'https://cdn.discordapp.com/';
function renderBadges() {
  const loggedIn = S.account === 'in';
  BADGE_LABELS.forEach(([selector, kind], i) => {
    const root = $(selector);
    const earned = loggedIn && Object.prototype.hasOwnProperty.call(S.earned, kind);
    const view = badgeView({ kind, tier: loggedIn ? S.tiers[kind] : null, earned, loggedIn, totals: S.totals, streamedHours: shownStreamHours() });
    const icon = root.querySelector('.bicon');
    const iconUrl = earned ? S.earned[kind] : '';
    const usable = typeof iconUrl === 'string' && iconUrl.startsWith(BADGE_ICON_HOST) && icon.dataset.failed !== iconUrl;
    icon.hidden = !usable;
    if (usable && icon.getAttribute('src') !== iconUrl) icon.src = iconUrl;
    setText(root.querySelector('.btier'), view.tierText);
    const bar = root.querySelector('.progress');
    bar.hidden = !view.showBar;
    bar.setAttribute('aria-valuenow', String(view.tier));
    bar.setAttribute('aria-valuetext', view.tierText);
    bar.querySelector('span').style.width = `${view.barPct}%`;
    setText(root.querySelector('.bnext'), view.nextText);
    setText(root.querySelector('.brange'), view.rangeText);
    fx?.badgeFill(i, view.tier);
  });
}
$$('.bicon').forEach((icon) => icon.addEventListener('error', () => {
  icon.dataset.failed = icon.getAttribute('src') || '';
  icon.hidden = true;
}));

function copyLog() {
  const area = el('textarea', 'sr-only');
  area.value = logLines.join('\n');
  area.setAttribute('aria-hidden', 'true');
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  const button = $('#logCopy');
  setText(button, copied ? 'Copied' : "Couldn't copy");
  announce(copied ? 'Activity log copied.' : "The activity log couldn't be copied.", !copied);
  setTimeout(() => setText(button, 'Copy log'), 1600);
  button.focus({ preventScroll: true });
}
async function openLogFolder() {
  const res = api.openLogFolder ? await api.openLogFolder().catch(failed) : { ok: false, error: 'This version has no log file.' };
  if (!res.ok) log(errorText(res, "The log folder couldn't be opened."), 'pink');
}
const actions = {
  login, logout,
  claim: () => startClaim(),
  stopClaim: () => stopClaim(),
  claimReset: () => { resetClaimPanel(); render(); $('#gCount').focus({ preventScroll: true }); },
  streamToggle: () => (S.stream.status === 'off' ? startStream() : stopStream()),
  altLogin, altLogout,
  addAccount, useAccount, removeAccount,
  retryBackend: async () => {
    S.backendDown = '';
    if (api.retryBackend) await api.retryBackend().catch(failed);
    restoreLogin();
  },
  copyLog, openLogFolder,
};
function closeMenu(refocus = true) {
  const focusInMenu = refocus && Boolean(document.activeElement?.closest('#acctMenu'));
  S.menuOpen = false;
  S.confirmSwitch = null;
  render();
  if (focusInMenu) $('#acctMenuBtn').focus({ preventScroll: true });
}
document.addEventListener('click', (e) => {
  const act = e.target.closest('[data-action]');
  if (S.confirmSwitch && !(act && act.dataset.action === 'useAccount')) { S.confirmSwitch = null; render(); }
  if (act && actions[act.dataset.action]) { actions[act.dataset.action](act.dataset.id, act.dataset.role); return; }
  if (e.target.closest('#acctMenuBtn')) { S.menuOpen = !S.menuOpen; S.confirmSwitch = null; render(); return; }
  if (S.menuOpen && !e.target.closest('#acctMenu')) closeMenu();
  const go = e.target.closest('[data-go]');
  if (go) goTo(go.dataset.go, false, go);
});
for (const node of [$('#acctMenu'), $('#acctMenuBtn')]) {
  node.addEventListener('focusout', (e) => {
    if (S.menuOpen && e.relatedTarget && !e.relatedTarget.closest('#acctMenu, #acctMenuBtn')) closeMenu(false);
  });
}
$('#gCount').addEventListener('input', () => updateMath(true));
$('#gHours').addEventListener('input', () => updateMath(true));
$('#gAll').addEventListener('click', () => {
  if (!S.games.all) S.games.count = $('#gCount').value;
  S.games.all = !S.games.all;
  if (!S.games.all) $('#gCount').value = S.games.count;
  render(); updateMath(true);
});
$('#autoWatch').addEventListener('click', async () => {
  const want = !S.alt.autoWatch;
  S.alt.autoWatch = want;
  log(want ? 'Auto-watch turned on' : 'Auto-watch turned off');
  render();
  const res = await api.setAutoWatch(want).catch(failed);
  if (!res.ok && S.alt.autoWatch === want) {
    S.alt.autoWatch = !want;
    log(errorText(res, "Auto-watch couldn't be changed."), 'pink');
    render();
  }
});
$$('input[name="mode"]').forEach((r) => r.addEventListener('change', () => {
  const st = S.stream;
  st.mode = r.value;
  const action = modeChangeAction({ status: st.status, accepted: st.accepted, mode: r.value, restartAs: st.restartAs });
  if (action === 'retarget') st.liveMode = r.value;
  else if (action === 'switch') switchMode(r.value);
  render();
}));
api.onLog((d) => {
  if (!d || !d.text) return;
  const problem = d.type === 'error' || d.type === 'warning';
  const isError = d.type === 'error';
  log(d.text, problem ? 'pink' : '', isError, isError);
});
api.onClaimProgress(onClaimProgress);
api.onClaimDone(onClaimDone);
api.onStreamStep(onStreamStep);
api.onStreamLive(goLive);
api.onStreamEnded(onStreamEnded);
api.onViewers((d) => {
  if (S.stream.status !== 'live' || !isCurrent(d, S.stream.run)) return;
  S.stream.viewers = d.count || 0;
  S.stream.counted = Number(d.counted) || 0;
  renderStream();
  renderBadges();
});
api.onAltStatus(onAltStatus);
api.onBackendRestart((d) => {
  if (S.games.status === 'running') { S.games.status = 'idle'; fx?.claimStop(); }
  if (S.stream.status !== 'off') resetStream();
  S.alt.account = 'out'; S.alt.name = ''; S.alt.status = 'idle';
  S.account = 'out';
  S.user = null;
  S.stream.endedHours = 0;
  S.menuOpen = false;
  S.confirmSwitch = null;
  serversLoad++; channelsLoad++;
  serverPicker.setStatus('Log in first');
  channelPicker.setStatus('Pick a server first');
  setPickerNote('');
  fx?.disconnected();
  if (d && d.final) {
    S.backendDown = d.reason || "The app's backend could not be started.";
    log(S.backendDown, 'pink');
    render();
    return;
  }
  log('The part of the app that talks to Discord stopped. Starting it again.', 'pink');
  render();
  restoreLogin();
});

const secEls = SECTIONS.map((id) => document.getElementById(id));
const mainEl = document.querySelector('main');
const navBtns = $$('.sidenav button');
const navFill = $('#navFill');
const fixedInMain = [...document.querySelectorAll('.orb-labels, .badge-labels')];
const layout = { vh: innerHeight, secTops: [], navCenters: [] };
let pageY = 0;
function setPageY(v) {
  pageY = v;
  mainEl.style.transform = `translate3d(0, ${-v}px, 0)`;
  fixedInMain.forEach((node) => { node.style.transform = `translate3d(0, ${v}px, 0)`; });
}
setPageY(0);
function measure() {
  layout.vh = innerHeight;
  layout.secTops = secEls.map((node) => node.offsetTop);
  layout.navCenters = navBtns.map((b) => b.offsetTop + b.offsetHeight / 2);
}
function scrollToF(y) {
  const tops = layout.secTops;
  if (y <= tops[0]) return 0;
  for (let i = 0; i < tops.length - 1; i++) {
    if (y < tops[i + 1]) return i + (y - tops[i]) / (tops[i + 1] - tops[i]);
  }
  return tops.length - 1;
}
const NAV_BASE_S = 1.0;
const NAV_PER_SECTION_S = 0.3;
const SHADE_SIDE = { account: 'none', games: 'left', stream: 'right', alt: 'left', badges: 'soft', activity: 'left' };
const shade = $('.shade');
let navTween = null;
let activeSection = 0;
function setActiveSection(idx) {
  activeSection = idx;
  secEls.forEach((node, i) => { node.inert = i !== idx; });
  navBtns.forEach((b, i) => {
    if (i === idx) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  });
  shade.dataset.side = SHADE_SIDE[SECTIONS[idx]] ?? 'none';
}
function showOnlyActive(only) {
  secEls.forEach((node, i) => node.classList.toggle('away', only && i !== activeSection));
}
function focusHeading(idx, trigger) {
  const sec = secEls[idx];
  if (!sec) return;
  const active = document.activeElement;
  const lost = !active || active === document.body || !active.isConnected || active.closest('[inert]') !== null;
  if (sec.contains(active)) return;
  if (!lost && active !== trigger) {
    announce(`${navBtns[idx].textContent.trim()} section`);
    return;
  }
  const heading = sec.querySelector('.display');
  if (heading) heading.focus({ preventScroll: true });
}
function alignToActive() {
  if (!navTween) setPageY(layout.secTops[activeSection]);
}
function goTo(id, instant = false, trigger = null) {
  const idx = SECTIONS.indexOf(id);
  if (idx < 0) return;
  measure();
  const from = pageY, to = layout.secTops[idx];
  const sections = Math.abs(scrollToF(to) - scrollToF(from));
  setActiveSection(idx);
  if (instant || Math.abs(to - from) < 1) {
    navTween = null;
    setPageY(to);
    showOnlyActive(true);
    if (!instant) focusHeading(idx, trigger);
    return;
  }
  showOnlyActive(false);
  navTween = { from, to, t: 0, dur: NAV_BASE_S + NAV_PER_SECTION_S * Math.max(0, sections - 1), idx, trigger };
}
function stepNav(dt) {
  if (!navTween) return;
  const n = navTween;
  n.to = layout.secTops[n.idx];
  n.t = Math.min(1, n.t + dt / n.dur);
  const e = 0.5 - 0.5 * Math.cos(Math.PI * n.t);
  setPageY(n.from + (n.to - n.from) * e);
  if (n.t >= 1) { navTween = null; showOnlyActive(true); focusHeading(n.idx, n.trigger); }
}
const headings = secEls.map((node) => node.querySelector('.display'));
const rules = secEls.map((node) => node.querySelector('.rule'));
const parEls = $$('[data-par]').map((node) => ({ el: node, k: Number(node.dataset.par), sec: SECTIONS.indexOf(node.closest('.chapter').id), last: '' }));
const NAV_TRACK_TOP = 16;
let introT = 0;
let lastFill = '';
const lastWidth = new Array(SECTIONS.length).fill(-1);
const lastFade = new Array(SECTIONS.length).fill(NaN);
const BAR_H = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bar-h')) || 52;

function updateScrollUI(dt) {
  const y = pageY;
  const { vh, secTops, navCenters } = layout;
  introT = Math.min(1, introT + dt / 1.6);
  secEls.forEach((node, i) => {
    const top = secTops[i] - y;
    let p;
    if (top >= 0) p = 1 - clamp((top / vh - 0.08) / 0.72, 0, 1);
    else p = 1 - clamp((-top / vh - 0.15) / 0.7, 0, 1) * 0.55;
    if (i === 0) p = Math.min(p, smooth(introT));
    const e = smooth(p);
    const w = Math.round((50 + 100 * e) * 4) / 4;
    if (w !== lastWidth[i]) {
      lastWidth[i] = w;
      headings[i].style.fontVariationSettings = `"wdth" ${w}, "wght" ${Math.round(540 + 320 * e)}`;
      if (rules[i]) rules[i].style.width = `${Math.round(24 + 96 * e)}px`;
    }
    const fade = Math.round(BAR_H - top);
    if (fade !== lastFade[i]) {
      lastFade[i] = fade;
      node.style.setProperty('--fade-top', `${fade}px`);
    }
  });
  for (const p of parEls) {
    const shift = (-(secTops[p.sec] - y) * p.k).toFixed(1);
    if (shift === p.last) continue;
    p.last = shift;
    p.el.style.transform = `translate3d(0, ${shift}px, 0)`;
  }
  const f = scrollToF(y);
  const i = Math.min(Math.floor(f), navCenters.length - 2);
  const center = navCenters[i] + (navCenters[i + 1] - navCenters[i]) * (f - i);
  const fill = Math.max(0, center - NAV_TRACK_TOP).toFixed(1);
  if (fill !== lastFill) {
    lastFill = fill;
    navFill.style.height = `${fill}px`;
  }
}

measure();
setActiveSection(0);
showOnlyActive(true);
updateMath(false);

let stage = null;
try {
  stage = buildScene({ S, $, scrollToF, getPageY: () => pageY, isWalking: () => navTween !== null, log });
  fx = stage.fxApi;
  fx.fromState();
} catch (err) {
  console.warn('3D view unavailable:', err);
  document.body.classList.add('no-gl');
  log('The 3D view is off on this PC. Everything else still works.', 'pink');
}
render();
restoreLogin();

const BOOT_SETTLE_MS = 350;
const fontsReady = Promise.all([
  document.fonts.load('650 54px Onest'), document.fonts.load('500 25px Onest'),
  document.fonts.load('900 340px Anybody'), document.fonts.load('700 56px Anybody'),
]).catch(() => null);
fontsReady.then(() => {
  measure();
  alignToActive();
  if (!stage) return;
  stage.setAtlas(stage.makeAtlas());
  if (S.stream.status === 'off') stage.drawScreen('off');
  fx.sync();
});
fontsReady.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  .then(() => setTimeout(hideBoot, BOOT_SETTLE_MS));

let resizePending = false;
addEventListener('resize', () => { resizePending = true; });
new ResizeObserver(() => { resizePending = true; }).observe(mainEl);
addEventListener('load', () => { resizePending = true; });
function applyResize() {
  resizePending = false;
  measure();
  stage?.resize();
  alignToActive();
}
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.menuOpen) { closeMenu(); $('#acctMenuBtn').focus(); }
});
addEventListener('scroll', () => { if (scrollX || scrollY) window.scrollTo(0, 0); }, { passive: true });

const MAX_FRAME_ERRORS = 3;
let frameErrors = 0;
let rafId = 0, running = false, last = 0;
function loop(now) {
  if (!running) return;
  rafId = requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
  last = now;
  if (resizePending) applyResize();
  stepNav(dt);
  updateScrollUI(dt);
  if (!stage) return;
  try {
    stage.frame(dt);
    frameErrors = 0;
  } catch (err) {
    console.warn('3D frame failed:', err);
    frameErrors += 1;
    if (frameErrors >= MAX_FRAME_ERRORS) {
      stage = null;
      fx = null;
      document.body.classList.add('no-gl');
      $('#streamVideo').pause();
      log('The 3D view stopped working and was turned off. Everything else still works.', 'pink');
    }
  }
}
function startLoop() {
  if (running) return;
  running = true;
  last = performance.now();
  rafId = requestAnimationFrame(loop);
}
function stopLoop() {
  running = false;
  cancelAnimationFrame(rafId);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopLoop(); $('#streamVideo').pause(); }
  else { startLoop(); fx?.sync(); }
});
startLoop();
