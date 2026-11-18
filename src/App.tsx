import { Octokit } from '@octokit/rest';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';

// --- CONFIGURATION ---
const REPO_OWNER = 'UkkoYlijumala';
const REPO_NAME = 'helsinki-metal-guide';
const API_FILE_PATH = 'events.json';
const MANUAL_FILE_PATH = 'manual_events.json';
// The n8n webhook that rebuilds the app data after a push. Put your own URL here (in this one place).
const N8N_WEBHOOK_URL = 'YOUR_N8N_WEBHOOK_URL_HERE';
// Dates are shown and typed in this time zone, whatever time zone the browser is in.
const TIME_ZONE = 'Europe/Helsinki';
const TOKEN_KEY = 'github_pat';

interface Lineup {
  id: string;
  artist: string;
  stageTime?: string;
  previewUrl?: string | null;
  appleMusicUrl?: string | null;
  previewCheckedAt?: string;
}

interface GigEvent {
  id: string;
  title: string;
  // Either a full ISO time ("2026-12-11T19:00:00.000Z") or just a day ("2026-12-11") when the time is not known
  date: string;
  endTime?: string;
  venue: { name: string; address?: string };
  lineup?: Lineup[];
  description: string;
  price?: string;
  ticketUrl?: string;
  image?: string;
  ageLimit?: string | number;
  addedDate?: string;
}

interface Status {
  kind: 'success' | 'error' | 'info';
  text: string;
}

// ---------------------------------------------------------------------------
// Dates: stored as ISO (UTC) or as a plain day, shown and entered in Helsinki time
// ---------------------------------------------------------------------------
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const zonedFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function zonedParts(ms: number): Record<string, number> {
  const values: Record<string, number> = {};
  for (const part of zonedFormatter.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return values;
}

// A moment given as calendar parts that are read as UTC, in milliseconds. Unlike Date.UTC this takes the years 0-99
// literally: a date field passes through years like 0002 while a year is being typed.
function utcMs(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime();
}

// How far the Helsinki clock is ahead of UTC at this moment, in milliseconds (2 h in winter, 3 h in summer).
// Not rounded to minutes, so that converting back and forth never drifts.
function offsetMs(ms: number): number {
  const p = zonedParts(ms);
  return utcMs(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

// The Helsinki date ("YYYY-MM-DD") and time ("HH:mm") of a stored date. The time is empty when only a day is stored.
function toFormParts(value: string | undefined): { date: string; time: string } {
  if (!value) return { date: '', time: '' };
  if (DAY_ONLY.test(value)) return { date: value, time: '' };
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return { date: '', time: '' };
  const p = zonedParts(ms);
  return { date: `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

// A Helsinki date and time to an ISO string (UTC), taking summer time into account
function wallTimeToIso(date: string, time: string): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})/.exec(time);
  if (!d || !t) return null;
  const wall = utcMs(Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2]), 0);
  // The offset depends on the moment itself: look it up at the wall time read as UTC, then once more at that result
  let ms = wall - offsetMs(wall);
  ms = wall - offsetMs(ms);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// The new stored date after the date or the time field changed. An empty time keeps only the day.
// A date field that is not a complete YYYY-MM-DD (cleared, or a year with five digits) leaves the value as it was.
function applyDateTime(current: string, field: 'date' | 'time', value: string): string {
  const parts = toFormParts(current);
  const date = field === 'date' ? value : parts.date;
  const time = field === 'time' ? value : parts.time;
  if (!DAY_ONLY.test(date)) return current;
  if (!time) return date;
  return wallTimeToIso(date, time) || current;
}

function toDateTimeLocal(value: string | undefined): string {
  const parts = toFormParts(value);
  return parts.date && parts.time ? `${parts.date}T${parts.time}` : '';
}

function formatListDate(value: string): string {
  if (!value) return 'No Date';
  const parts = toFormParts(value);
  if (!parts.date) return 'Invalid Date';
  const [year, month, day] = parts.date.split('-');
  return `${day}.${month}.${year}${parts.time ? ` ${parts.time}` : ''}`;
}

function timeOf(event: GigEvent): number {
  const ms = Date.parse(event.date);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

// Oldest first, events without a usable date last
function byDate(a: GigEvent, b: GigEvent): number {
  const difference = timeOf(a) - timeOf(b);
  if (difference !== 0 && !Number.isNaN(difference)) return difference;
  return (a.title || '').localeCompare(b.title || '');
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------
// GitHub answers may be kept by the browser for a minute. A request that carries this header is never taken from the
// cache, so a reload right after a push does not show the old file (and the old sha).
const NO_CACHE = { 'If-None-Match': '' };

function getStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeBase64(base64: string): string {
  const binary = atob(base64.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// The text and the sha of a file in the repo, or null when the file does not exist
async function readRepoFile(octokit: Octokit, path: string): Promise<{ text: string; sha: string } | null> {
  let response;
  try {
    response = await octokit.rest.repos.getContent({ owner: REPO_OWNER, repo: REPO_NAME, path, headers: NO_CACHE });
  } catch (error) {
    if (getStatus(error) === 404) return null;
    throw error;
  }
  const data = response.data;
  if (Array.isArray(data) || data.type !== 'file') throw new Error(`${path} is not a file`);
  if (data.encoding === 'base64' && data.content) return { text: decodeBase64(data.content), sha: data.sha };
  // This endpoint sends no content for files over 1 MB: ask for the raw file instead
  const raw = await octokit.rest.repos.getContent({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    path,
    mediaType: { format: 'raw' },
    headers: NO_CACHE,
  });
  // Normally the raw file arrives as text. Make sure an answer in another shape is never mistaken for an empty file:
  // saving on top of "empty" would wipe the file.
  const body: unknown = raw.data;
  if (typeof body === 'string') return { text: body, sha: data.sha };
  if (body instanceof ArrayBuffer) return { text: new TextDecoder('utf-8').decode(body), sha: data.sha };
  if (typeof body === 'object' && body !== null) return { text: JSON.stringify(body), sha: data.sha };
  throw new Error(`${path} could not be read`);
}

// events.json and manual_events.json hold either a list of events or { events: [...] }
function parseEventList(text: string, fileName: string): GigEvent[] {
  if (text.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${fileName} is not valid JSON`);
  }
  if (Array.isArray(parsed)) return parsed as GigEvent[];
  if (typeof parsed === 'object' && parsed !== null) {
    const events = (parsed as { events?: unknown }).events;
    if (Array.isArray(events)) return events as GigEvent[];
  }
  throw new Error(`${fileName} does not hold a list of events`);
}

// The text of an events file without the events that have one of these ids. The layout of the file (indent, an
// { events: [...] } wrapper, the final newline) stays as it was, so GitHub shows only the removed events as the change.
function removeEventsFromJson(text: string, ids: ReadonlySet<string>, fileName: string): { text: string; removed: number } {
  if (text.trim() === '') return { text, removed: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${fileName} is not valid JSON`);
  }
  const isListed = (event: unknown): boolean => {
    if (typeof event !== 'object' || event === null) return false;
    const id = (event as { id?: unknown }).id;
    return typeof id === 'string' && ids.has(id);
  };
  let output: unknown;
  let removed = 0;
  if (Array.isArray(parsed)) {
    const kept = parsed.filter((event) => !isListed(event));
    removed = parsed.length - kept.length;
    output = kept;
  } else if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { events?: unknown }).events)) {
    const wrapper = parsed as { events: unknown[] };
    const kept = wrapper.events.filter((event) => !isListed(event));
    removed = wrapper.events.length - kept.length;
    output = { ...wrapper, events: kept };
  } else {
    throw new Error(`${fileName} does not hold a list of events`);
  }
  if (removed === 0) return { text, removed: 0 };
  const indent = /^\s*[[{][ \t]*\r?\n([ \t]+)\S/.exec(text);
  const body = JSON.stringify(output, null, indent ? indent[1] : undefined);
  return { text: /\n\s*$/.test(text) ? `${body}\n` : body, removed };
}

// Removes events from events.json. The file is read again right before, so whatever n8n added meanwhile is kept, and
// when the file changes between that read and the write, the whole step is done once more.
async function removeFromEventsFile(octokit: Octokit, ids: string[]): Promise<number> {
  const idSet = new Set(ids);
  for (let attempt = 1; ; attempt++) {
    const file = await readRepoFile(octokit, API_FILE_PATH);
    if (!file) return 0;
    const result = removeEventsFromJson(file.text, idSet, API_FILE_PATH);
    if (result.removed === 0) return 0;
    try {
      await octokit.rest.repos.createOrUpdateFileContents({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: API_FILE_PATH,
        message: 'Admin Tool: Remove deleted events',
        content: encodeBase64(result.text),
        sha: file.sha,
      });
      return result.removed;
    } catch (error) {
      const status = getStatus(error);
      if ((status === 409 || status === 422) && attempt < 2) continue;
      throw error;
    }
  }
}

function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function describePushError(error: unknown, fileName: string): string {
  const status = getStatus(error);
  if (status === 409 || status === 422) {
    return fileName === MANUAL_FILE_PATH
      ? `${MANUAL_FILE_PATH} was changed on GitHub after you loaded it. Nothing was overwritten. Press Reload to get the latest version (this drops the changes that are not pushed) and make your change again.`
      : `${fileName} was changed on GitHub while saving (n8n may be running). Nothing was overwritten. Wait a moment and press Push to GitHub again.`;
  }
  if (status === 401) return 'GitHub did not accept the token. Log out and log in again with a valid token.';
  if (status === 403 || status === 404) {
    return 'GitHub refused the save. Check that the token has write access (Contents: Read and write) to this repository.';
  }
  return `Saving failed: ${errorText(error)}`;
}

function readStoredToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const labelStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.25rem', fontWeight: 'bold' };
const inputStyle: CSSProperties = { padding: '0.5rem', border: '1px solid #ccc', borderRadius: '4px', fontWeight: 'normal' };
const smallButtonStyle: CSSProperties = { padding: '0.5rem', cursor: 'pointer' };
const hintStyle: CSSProperties = { fontSize: '0.75rem', color: '#777', fontWeight: 'normal' };
const bannerColors: Record<Status['kind'], CSSProperties> = {
  success: { backgroundColor: '#d1e7dd', color: '#0f5132' },
  error: { backgroundColor: '#f8d7da', color: '#842029' },
  info: { backgroundColor: '#cff4fc', color: '#055160' },
};

export default function App() {
  const [pat, setPat] = useState(readStoredToken);
  const [isAuthenticated, setIsAuthenticated] = useState(() => readStoredToken() !== '');
  const [loginError, setLoginError] = useState('');

  const [apiEvents, setApiEvents] = useState<GigEvent[]>([]);
  const [manualEvents, setManualEvents] = useState<GigEvent[]>([]);
  const [fileSha, setFileSha] = useState('');
  // What manual_events.json held when it was loaded or last pushed, to see if there is something to push
  const [savedManualJson, setSavedManualJson] = useState('[]');
  // Events that were deleted in this page and are removed from events.json with the next push
  const [pendingDeletes, setPendingDeletes] = useState<string[]>([]);
  // True when manual_events.json was pushed but the rebuild was not requested yet, because a later step of that push failed
  const [rebuildWanted, setRebuildWanted] = useState(false);
  // False when manual_events.json could not be read: pushing then could overwrite it with an incomplete list
  const [canSave, setCanSave] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);

  const [search, setSearch] = useState('');
  const [onlyMine, setOnlyMine] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<GigEvent | null>(null);
  // The selected event as it was when it was opened, to see if the form has unsaved changes
  const [selectedBaseline, setSelectedBaseline] = useState('');

  const octokit = useMemo(() => (isAuthenticated ? new Octokit({ auth: pat }) : null), [isAuthenticated, pat]);

  const logout = useCallback((message = '') => {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // storage is not available: nothing to remove
    }
    setPat('');
    setIsAuthenticated(false);
    setApiEvents([]);
    setManualEvents([]);
    setPendingDeletes([]);
    setRebuildWanted(false);
    setFileSha('');
    setSavedManualJson('[]');
    setCanSave(false);
    setSelectedEvent(null);
    setSelectedBaseline('');
    setStatus(null);
    setLoginError(message);
  }, []);

  const loadAll = useCallback(async () => {
    if (!octokit) return;
    setLoading(true);
    setStatus(null);
    setPendingDeletes([]);
    try {
      // events.json: read here; it is only written when events are deleted (see saveToGitHub)
      let apiList: GigEvent[] = [];
      let apiProblem = '';
      try {
        const apiFile = await readRepoFile(octokit, API_FILE_PATH);
        if (apiFile) apiList = parseEventList(apiFile.text, API_FILE_PATH);
        else apiProblem = `${API_FILE_PATH} was not found in the repository.`;
      } catch (error) {
        if (getStatus(error) === 401) throw error;
        apiProblem = `Could not read ${API_FILE_PATH}: ${errorText(error)}`;
      }

      // The events.json list can be shown whatever happens with the manual file
      setApiEvents(apiList);

      // manual_events.json: a missing file is fine (it is created by the first push), any other problem stops saving
      const manualFile = await readRepoFile(octokit, MANUAL_FILE_PATH);
      const manualList = manualFile ? parseEventList(manualFile.text, MANUAL_FILE_PATH) : [];

      setManualEvents(manualList);
      setFileSha(manualFile ? manualFile.sha : '');
      setSavedManualJson(JSON.stringify(manualList));
      setCanSave(true);
      if (apiProblem) setStatus({ kind: 'error', text: apiProblem });
    } catch (error) {
      console.error('Error fetching files.', error);
      if (getStatus(error) === 401) {
        logout('GitHub did not accept the token. Check it and try again.');
      } else {
        setManualEvents([]);
        setFileSha('');
        setSavedManualJson('[]');
        setCanSave(false);
        setStatus({
          kind: 'error',
          text: `Could not load the event files (${errorText(error)}). Saving is switched off so that nothing on GitHub gets overwritten. Press Reload to try again.`,
        });
      }
    } finally {
      setLoading(false);
    }
  }, [octokit, logout]);

  useEffect(() => {
    if (isAuthenticated) loadAll();
  }, [isAuthenticated, loadAll]);

  // A success or info message goes away by itself
  useEffect(() => {
    if (!status || status.kind === 'error') return undefined;
    const timer = setTimeout(() => setStatus(null), 8000);
    return () => clearTimeout(timer);
  }, [status]);

  // The events of events.json, without the ones that were deleted here and wait for the next push
  const listedApiEvents = useMemo(() => {
    if (pendingDeletes.length === 0) return apiEvents;
    const deleted = new Set(pendingDeletes);
    return apiEvents.filter((ev) => !deleted.has(ev.id));
  }, [apiEvents, pendingDeletes]);

  const apiIds = useMemo(() => new Set(listedApiEvents.map((ev) => ev.id)), [listedApiEvents]);
  const manualIds = useMemo(() => new Set(manualEvents.map((ev) => ev.id)), [manualEvents]);

  const displayEvents = useMemo(() => {
    const eventMap = new Map<string, GigEvent>();
    listedApiEvents.forEach((ev) => eventMap.set(ev.id, ev));
    manualEvents.forEach((ev) => eventMap.set(ev.id, ev));
    return Array.from(eventMap.values()).sort(byDate);
  }, [listedApiEvents, manualEvents]);

  const visibleEvents = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return displayEvents.filter((ev) => {
      if (onlyMine && !manualIds.has(ev.id)) return false;
      if (!needle) return true;
      const text = `${ev.title || ''} ${(ev.venue && ev.venue.name) || ''} ${formatListDate(ev.date)}`.toLowerCase();
      return text.includes(needle);
    });
  }, [displayEvents, manualIds, search, onlyMine]);

  const manualChanged = useMemo(() => JSON.stringify(manualEvents) !== savedManualJson, [manualEvents, savedManualJson]);
  const hasUnpushedChanges = manualChanged || pendingDeletes.length > 0;
  const formDirty = selectedEvent !== null && JSON.stringify(selectedEvent) !== selectedBaseline;

  // Warn before the tab is closed while there are changes that would be lost
  useEffect(() => {
    if (!hasUnpushedChanges && !formDirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnpushedChanges, formDirty]);

  const confirmDiscardForm = () => !formDirty || window.confirm('Discard the changes you made in the form?');

  const closeForm = () => {
    setSelectedEvent(null);
    setSelectedBaseline('');
  };

  const openEvent = (ev: GigEvent) => {
    if (selectedEvent && selectedEvent.id === ev.id) return;
    if (!confirmDiscardForm()) return;
    setSelectedEvent(ev);
    setSelectedBaseline(JSON.stringify(ev));
  };

  const addNewEvent = () => {
    if (!confirmDiscardForm()) return;
    const created: GigEvent = {
      id: `manual-${Date.now()}`,
      title: '',
      date: new Date().toISOString(),
      venue: { name: '', address: '' },
      lineup: [],
      description: '',
      price: '',
      ticketUrl: '',
      image: '',
      ageLimit: '',
      addedDate: new Date().toISOString(),
    };
    setSelectedEvent(created);
    setSelectedBaseline(JSON.stringify(created));
  };

  const reload = () => {
    if ((hasUnpushedChanges || formDirty) && !window.confirm('Reload from GitHub? The changes that are not pushed will be lost.')) return;
    closeForm();
    loadAll();
  };

  const requestLogout = () => {
    if ((hasUnpushedChanges || formDirty) && !window.confirm('Log out? The changes that are not pushed will be lost.')) return;
    logout();
  };

  const handleLogin = (e: FormEvent) => {
    e.preventDefault();
    const token = pat.trim();
    if (!token) return;
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      // the token is only kept in memory then
    }
    setPat(token);
    setLoginError('');
    setIsAuthenticated(true);
  };

  // Asks n8n to rebuild, without waiting for its answer (a webhook that answers only when the whole workflow is done
  // could keep this page waiting for minutes). "no-cors": n8n does not need to allow this page, the request is sent
  // anyway (the answer just cannot be read). "keepalive": the request also goes through if the tab is closed right away.
  const triggerRebuild = (): string => {
    if (!N8N_WEBHOOK_URL || N8N_WEBHOOK_URL.startsWith('YOUR_')) {
      return 'No n8n webhook is set in the code, so no rebuild was requested.';
    }
    fetch(N8N_WEBHOOK_URL, { method: 'POST', mode: 'no-cors', keepalive: true }).catch((webhookError) => {
      console.error('Data saved, but failed to trigger n8n rebuild', webhookError);
      setStatus({ kind: 'error', text: 'Pushed to GitHub, but the call to the n8n webhook failed, so no rebuild was requested.' });
    });
    return 'n8n was asked to rebuild.';
  };

  const saveToGitHub = async () => {
    if (!octokit || !canSave || saving) return;
    if (!hasUnpushedChanges) {
      setStatus({
        kind: 'info',
        text: formDirty
          ? 'Nothing to push yet. The open form has changes: press "Save to List" first.'
          : `Nothing to push: ${MANUAL_FILE_PATH} on GitHub already matches this list.`,
      });
      return;
    }
    if (formDirty && !window.confirm('The open form has changes that are not saved to the list, so they will not be pushed. Push anyway?')) {
      return;
    }
    setSaving(true);
    setStatus(null);
    const done: string[] = [];
    let step = MANUAL_FILE_PATH;
    let manualPushed = false;
    try {
      // 1. manual_events.json (only when it changed)
      if (manualChanged) {
        const json = `${JSON.stringify(manualEvents, null, 2)}\n`;
        const response = await octokit.rest.repos.createOrUpdateFileContents({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          path: MANUAL_FILE_PATH,
          message: 'Admin Tool: Update manual events',
          content: encodeBase64(json),
          sha: fileSha || undefined,
        });
        setFileSha(response.data.content?.sha || '');
        setSavedManualJson(JSON.stringify(manualEvents));
        manualPushed = true;
        setRebuildWanted(true);
        done.push(`Pushed ${countOf(manualEvents.length, 'manual event')} to GitHub.`);
      }
      // 2. events.json: take out the events that were deleted here
      if (pendingDeletes.length > 0) {
        step = API_FILE_PATH;
        const removed = await removeFromEventsFile(octokit, pendingDeletes);
        const deleted = new Set(pendingDeletes);
        setApiEvents((prev) => prev.filter((ev) => !deleted.has(ev.id)));
        // not simply emptied: an event deleted while this push was running must stay on the list for the next push
        setPendingDeletes((prev) => prev.filter((id) => !deleted.has(id)));
        done.push(removed > 0 ? `Removed ${countOf(removed, 'event')} from ${API_FILE_PATH}.` : `The deleted events were already gone from ${API_FILE_PATH}.`);
      }
      // Only manual events need a rebuild. After a deletion alone there is nothing to merge, and a rebuild could bring
      // the deleted event straight back if it also comes from one of the automatic sources.
      const rebuildNote = manualPushed || rebuildWanted ? triggerRebuild() : 'No rebuild was requested, there was nothing new to merge.';
      setRebuildWanted(false);
      setStatus({ kind: 'success', text: `${done.join(' ')} ${rebuildNote}` });
    } catch (error) {
      console.error('Failed to save', error);
      const earlier = manualPushed ? `${done.join(' ')} The deletion from ${API_FILE_PATH} did not go through. ` : '';
      setStatus({ kind: 'error', text: `${earlier}${describePushError(error, step)}` });
    } finally {
      setSaving(false);
    }
  };

  const updateEvent = (patch: Partial<GigEvent>) => {
    setSelectedEvent((current) => (current ? { ...current, ...patch } : current));
  };

  // --- LINEUP HANDLERS ---
  const addLineupItem = () => {
    if (!selectedEvent) return;
    const currentLineup = selectedEvent.lineup || [];
    updateEvent({ lineup: [...currentLineup, { id: `band-${Date.now()}`, artist: '', stageTime: '' }] });
  };

  const updateLineupItem = (index: number, field: 'artist' | 'stageTime', value: string) => {
    if (!selectedEvent || !selectedEvent.lineup) return;
    const renamed = field === 'artist' && value !== selectedEvent.lineup[index].artist;
    const newLineup = [...selectedEvent.lineup];
    newLineup[index] = { ...newLineup[index], [field]: value };
    if (renamed) {
      // The Apple link belongs to the old name. Without it, n8n looks the new name up again on its next run.
      delete newLineup[index].previewUrl;
      delete newLineup[index].appleMusicUrl;
      delete newLineup[index].previewCheckedAt;
    }
    updateEvent({ lineup: newLineup });
  };

  const removeLineupItem = (index: number) => {
    if (!selectedEvent || !selectedEvent.lineup) return;
    updateEvent({ lineup: selectedEvent.lineup.filter((_, i) => i !== index) });
  };
  // -----------------------

  const handleDateTimeChange = (field: 'date' | 'time', value: string) => {
    if (!selectedEvent) return;
    updateEvent({ date: applyDateTime(selectedEvent.date, field, value) });
  };

  const handleEndTimeChange = (value: string) => {
    if (!value) {
      updateEvent({ endTime: undefined });
      return;
    }
    const [date, time] = value.split('T');
    const iso = wallTimeToIso(date, time || '');
    if (iso) updateEvent({ endTime: iso });
  };

  const saveLocalEvent = (e: FormEvent) => {
    e.preventDefault();
    if (!selectedEvent) return;
    // Nothing changed on an event that already exists: do not make a copy of it in manual_events.json
    if (!formDirty && (manualIds.has(selectedEvent.id) || apiIds.has(selectedEvent.id))) {
      closeForm();
      return;
    }
    const toSave: GigEvent = {
      ...selectedEvent,
      title: (selectedEvent.title || '').trim(),
      venue: { ...selectedEvent.venue, name: (selectedEvent.venue?.name || '').trim() },
    };
    setManualEvents((prev) => {
      if (prev.some((ev) => ev.id === toSave.id)) return prev.map((ev) => (ev.id === toSave.id ? toSave : ev));
      return [...prev, toSave];
    });
    closeForm();
  };

  // Takes the event out of the list. What is in events.json goes from there with the next push, together with the copy
  // in manual_events.json (if there is one).
  const deleteEvent = () => {
    if (!selectedEvent) return;
    const id = selectedEvent.id;
    const inApiFile = apiIds.has(id);
    const inManualFile = manualIds.has(id);
    if (!inApiFile && !inManualFile) return;
    // the title as it is in the list, not what may have been typed in the form meanwhile
    const listed = displayEvents.find((ev) => ev.id === id);
    const name = (listed && listed.title) || selectedEvent.title || id;
    const lines = inApiFile
      ? [`Delete "${name}"?`, `It is removed from ${API_FILE_PATH}${inManualFile ? ` and ${MANUAL_FILE_PATH}` : ''} when you press Push to GitHub.`]
      : [`Delete "${name}" from ${MANUAL_FILE_PATH}?`, 'This takes effect when you press Push to GitHub.'];
    if (inApiFile && !id.startsWith('manual-')) {
      lines.push('If this event comes from an automatic source, n8n may add it again on a later run.');
    }
    if (!window.confirm(lines.join('\n\n'))) return;
    setManualEvents((prev) => prev.filter((ev) => ev.id !== id));
    if (inApiFile) setPendingDeletes((prev) => (prev.includes(id) ? prev : [...prev, id]));
    closeForm();
    setStatus({ kind: 'info', text: `Deleted "${name}" from the list. Press Push to GitHub to make it final.` });
  };

  // Only for an event that exists in events.json too: go back to that version
  const removeMyChanges = () => {
    if (!selectedEvent) return;
    if (!window.confirm(`Remove your changes to this event? The version in ${API_FILE_PATH} stays.`)) return;
    const id = selectedEvent.id;
    setManualEvents((prev) => prev.filter((ev) => ev.id !== id));
    closeForm();
  };

  if (!isAuthenticated) {
    return (
      <div style={{ padding: '2rem', maxWidth: '400px', margin: '0 auto' }}>
        <h2>Metalground Admin</h2>
        <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <input
            type="password"
            placeholder="Paste GitHub PAT here"
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            required
            style={{ padding: '0.5rem' }}
          />
          <button type="submit" style={{ padding: '0.5rem' }}>Login</button>
          {loginError && <div style={{ color: '#842029', fontSize: '0.9rem' }}>{loginError}</div>}
          <div style={hintStyle}>
            Tip: use a fine-grained token for this repository only, with "Contents: Read and write" and an expiry date.
          </div>
        </form>
      </div>
    );
  }

  const selectedIsManual = selectedEvent ? manualIds.has(selectedEvent.id) : false;
  const selectedInApi = selectedEvent ? apiIds.has(selectedEvent.id) : false;
  const selectedParts = toFormParts(selectedEvent ? selectedEvent.date : '');
  const endBeforeStart =
    selectedEvent !== null &&
    !!selectedEvent.endTime &&
    Date.parse(selectedEvent.endTime) <= Date.parse(selectedEvent.date);
  const pushDisabled = loading || saving || !canSave;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', height: '100vh', fontFamily: 'sans-serif' }}>
      {/* LEFT COLUMN: LIST */}
      <div style={{ borderRight: '1px solid #ccc', padding: '1rem', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.75rem', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
          <h2 style={{ margin: 0 }}>
            All Events ({visibleEvents.length === displayEvents.length ? displayEvents.length : `${visibleEvents.length} of ${displayEvents.length}`})
          </h2>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {hasUnpushedChanges && <span style={{ fontSize: '0.75rem', color: '#b35c00', fontWeight: 'bold' }}>Not pushed yet</span>}
            <button onClick={addNewEvent} style={smallButtonStyle}>+ New Event</button>
            <button onClick={reload} disabled={loading || saving} style={smallButtonStyle}>Reload</button>
            <button
              onClick={saveToGitHub}
              disabled={pushDisabled}
              title={!canSave ? `Saving is off: ${MANUAL_FILE_PATH} could not be read` : undefined}
              style={{ padding: '0.5rem', backgroundColor: '#ff535b', color: 'white', border: 'none', borderRadius: '4px', cursor: pushDisabled ? 'default' : 'pointer', opacity: pushDisabled ? 0.5 : 1 }}
            >
              {saving ? 'Saving...' : 'Push to GitHub'}
            </button>
            <button onClick={requestLogout} style={smallButtonStyle}>Log out</button>
          </div>
        </div>

        {status && (
          <div role="status" style={{ ...bannerColors[status.kind], padding: '0.6rem 0.75rem', borderRadius: '4px', marginBottom: '0.75rem', fontSize: '0.9rem' }}>
            {status.text}
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '0.75rem' }}>
          <input
            type="search"
            placeholder="Search title, venue or date"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ ...inputStyle, flex: 1 }}
          />
          <label style={{ whiteSpace: 'nowrap', fontSize: '0.85rem' }}>
            <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} /> Only my events
          </label>
        </div>

        {loading && <div style={{ color: '#666', marginBottom: '0.75rem' }}>Loading...</div>}

        {visibleEvents.map((ev) => {
          const isManual = manualIds.has(ev.id);
          return (
            <div
              key={ev.id}
              role="button"
              tabIndex={0}
              onClick={() => openEvent(ev)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openEvent(ev);
                }
              }}
              style={{
                padding: '0.75rem',
                border: '1px solid #ddd',
                marginBottom: '0.5rem',
                cursor: 'pointer',
                backgroundColor: selectedEvent?.id === ev.id ? '#e9ecef' : 'transparent',
                borderLeft: isManual ? '4px solid #ff535b' : '1px solid #ddd',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong>{ev.title}</strong>
                {isManual && (
                  <span style={{ fontSize: '0.7rem', color: '#ff535b', fontWeight: 'bold' }}>
                    {ev.id.startsWith('manual-') ? 'MANUAL' : 'EDITED'}
                  </span>
                )}
              </div>
              <div style={{ fontSize: '0.85rem', color: '#666', marginTop: '0.25rem' }}>
                {formatListDate(ev.date)} @ {ev.venue?.name || 'Unknown'}
              </div>
            </div>
          );
        })}
        {!loading && visibleEvents.length === 0 && <div style={{ color: '#666' }}>No events found.</div>}
      </div>

      {/* RIGHT COLUMN: FORM */}
      <div style={{ padding: '1rem', overflowY: 'auto', backgroundColor: '#f8f9fa' }}>
        {selectedEvent ? (
          <form onSubmit={saveLocalEvent} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', backgroundColor: 'white', padding: '1.5rem', borderRadius: '8px', border: '1px solid #dee2e6' }}>
            <div>
              <h2 style={{ margin: 0 }}>{selectedIsManual || selectedInApi ? 'Edit Event Data' : 'Create New Event'}</h2>
              <div style={hintStyle}>ID: {selectedEvent.id}</div>
            </div>

            <label style={labelStyle}>
              Title:
              <input type="text" value={selectedEvent.title || ''} onChange={(e) => updateEvent({ title: e.target.value })} required style={inputStyle} />
            </label>

            {/* LINEUP SECTION */}
            <div style={{ border: '1px solid #ccc', padding: '1rem', borderRadius: '4px', backgroundColor: '#fdfdfd' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <strong style={{ fontSize: '0.9rem' }}>Lineup / Warm-up Bands</strong>
                <button type="button" onClick={addLineupItem} style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem', cursor: 'pointer', backgroundColor: '#e9ecef', border: '1px solid #ccc', borderRadius: '4px' }}>+ Add Band</button>
              </div>

              {(selectedEvent.lineup || []).map((band, index) => (
                <div key={band.id || `band-index-${index}`} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', alignItems: 'center' }}>
                  <input
                    type="text"
                    placeholder="Artist name"
                    value={band.artist}
                    onChange={(e) => updateLineupItem(index, 'artist', e.target.value)}
                    style={{ flex: 2, padding: '0.5rem', border: '1px solid #ccc', borderRadius: '4px' }}
                    required
                  />
                  <input
                    type="text"
                    placeholder="Time (e.g. 21:00)"
                    value={band.stageTime || ''}
                    onChange={(e) => updateLineupItem(index, 'stageTime', e.target.value)}
                    style={{ flex: 1, padding: '0.5rem', border: '1px solid #ccc', borderRadius: '4px' }}
                  />
                  <button type="button" onClick={() => removeLineupItem(index)} style={{ padding: '0.5rem', backgroundColor: '#dc3545', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>X</button>
                </div>
              ))}
              {(!selectedEvent.lineup || selectedEvent.lineup.length === 0) && (
                <div style={{ fontSize: '0.85rem', color: '#888', fontStyle: 'italic' }}>No additional bands added yet.</div>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <label style={labelStyle}>
                Date:
                <input type="date" value={selectedParts.date} onChange={(e) => handleDateTimeChange('date', e.target.value)} required style={inputStyle} />
              </label>
              <label style={labelStyle}>
                Time:
                <input type="time" value={selectedParts.time} onChange={(e) => handleDateTimeChange('time', e.target.value)} style={inputStyle} />
                <span style={hintStyle}>{selectedParts.time ? 'Helsinki time' : 'No time set (only the day is saved)'}</span>
              </label>
            </div>

            <label style={labelStyle}>
              End time (optional):
              <input type="datetime-local" value={toDateTimeLocal(selectedEvent.endTime)} onChange={(e) => handleEndTimeChange(e.target.value)} style={inputStyle} />
              {endBeforeStart && <span style={{ ...hintStyle, color: '#842029' }}>The end is not after the start.</span>}
            </label>

            <label style={labelStyle}>
              Venue Name:
              <input type="text" value={selectedEvent.venue?.name || ''} onChange={(e) => updateEvent({ venue: { ...selectedEvent.venue, name: e.target.value } })} required style={inputStyle} />
            </label>

            <label style={labelStyle}>
              Venue Address:
              <input type="text" value={selectedEvent.venue?.address || ''} onChange={(e) => updateEvent({ venue: { ...selectedEvent.venue, address: e.target.value } })} style={inputStyle} />
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <label style={labelStyle}>
                Price:
                <input type="text" value={selectedEvent.price || ''} onChange={(e) => updateEvent({ price: e.target.value })} style={inputStyle} />
              </label>

              <label style={labelStyle}>
                Age Limit:
                <input type="text" value={selectedEvent.ageLimit || ''} onChange={(e) => updateEvent({ ageLimit: e.target.value })} style={inputStyle} />
              </label>
            </div>

            <label style={labelStyle}>
              Ticket URL:
              <input type="url" value={selectedEvent.ticketUrl || ''} onChange={(e) => updateEvent({ ticketUrl: e.target.value })} style={inputStyle} />
            </label>

            <label style={labelStyle}>
              Image URL:
              <input type="url" value={selectedEvent.image || ''} onChange={(e) => updateEvent({ image: e.target.value })} style={inputStyle} />
            </label>

            <label style={labelStyle}>
              Description:
              <textarea value={selectedEvent.description || ''} onChange={(e) => updateEvent({ description: e.target.value })} rows={6} style={inputStyle} />
            </label>

            <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', gap: '1rem' }}>
                <button
                  type="submit"
                  title="Keeps the change in this page. Use Push to GitHub to publish it."
                  style={{ padding: '0.5rem 1rem', backgroundColor: '#333', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                >
                  Save to List
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (confirmDiscardForm()) closeForm();
                  }}
                  style={{ padding: '0.5rem 1rem', backgroundColor: '#e9ecef', color: '#333', border: '1px solid #ccc', borderRadius: '4px', cursor: 'pointer' }}
                >
                  Cancel
                </button>
              </div>
              <div style={{ display: 'flex', gap: '1rem' }}>
                {selectedIsManual && selectedInApi && (
                  <button
                    type="button"
                    onClick={removeMyChanges}
                    title={`Go back to the version in ${API_FILE_PATH}`}
                    style={{ padding: '0.5rem 1rem', backgroundColor: 'white', color: '#dc3545', border: '1px solid #dc3545', borderRadius: '4px', cursor: 'pointer' }}
                  >
                    Remove My Changes
                  </button>
                )}
                {(selectedIsManual || selectedInApi) && (
                  <button type="button" onClick={deleteEvent} style={{ padding: '0.5rem 1rem', backgroundColor: '#dc3545', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
                    Delete Event
                  </button>
                )}
              </div>
            </div>
          </form>
        ) : (
          <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: '#666' }}>
            Select an event from the list to edit, or create a new one.
          </div>
        )}
      </div>
    </div>
  );
}
