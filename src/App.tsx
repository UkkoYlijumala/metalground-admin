import { Octokit } from '@octokit/rest';
import { useEffect, useState } from 'react';

// --- CONFIGURATION ---
const REPO_OWNER = 'UkkoYlijumala';
const REPO_NAME = 'helsinki-metal-guide'; 
const API_FILE_PATH = 'events.json'; 
const MANUAL_FILE_PATH = 'manual_events.json'; 

interface Lineup {
  id: string;
  artist: string;
  stageTime?: string;
}

interface Event {
  id: string;
  title: string;
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

export default function App() {
  const [pat, setPat] = useState(sessionStorage.getItem('github_pat') || '');
  const [isAuthenticated, setIsAuthenticated] = useState(!!pat);
  
  const [apiEvents, setApiEvents] = useState<Event[]>([]);
  const [manualEvents, setManualEvents] = useState<Event[]>([]);
  const [fileSha, setFileSha] = useState('');
  const [loading, setLoading] = useState(false);
  
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);

  const octokit = new Octokit({ auth: pat });

  useEffect(() => {
    if (isAuthenticated) fetchAllEvents();
  }, [isAuthenticated]);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    sessionStorage.setItem('github_pat', pat);
    setIsAuthenticated(true);
  };

  const fetchAllEvents = async () => {
    setLoading(true);
    try {
      const apiResponse = await octokit.rest.repos.getContent({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: API_FILE_PATH,
      });

      if (!Array.isArray(apiResponse.data) && apiResponse.data.type === 'file') {
        const decodedApi = decodeURIComponent(escape(atob(apiResponse.data.content)));
        const parsedApi = JSON.parse(decodedApi);
        setApiEvents(Array.isArray(parsedApi) ? parsedApi : (parsedApi.events || []));
      }

      const manualResponse = await octokit.rest.repos.getContent({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: MANUAL_FILE_PATH,
      });

      if (!Array.isArray(manualResponse.data) && manualResponse.data.type === 'file') {
        setFileSha(manualResponse.data.sha);
        const decodedManual = decodeURIComponent(escape(atob(manualResponse.data.content)));
        const parsedManual = JSON.parse(decodedManual);
        setManualEvents(Array.isArray(parsedManual) ? parsedManual : []);
      }
    } catch (error) {
      console.error('Error fetching files.', error);
      alert('Failed to fetch data. Check console.');
      setApiEvents([]);
      setManualEvents([]);
    } finally {
      setLoading(false);
    }
  };

  const saveToGitHub = async () => {
    setLoading(true);
    try {
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(manualEvents, null, 2))));
      
      const response = await octokit.rest.repos.createOrUpdateFileContents({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: MANUAL_FILE_PATH,
        message: 'Admin Tool: Update manual events',
        content: content,
        sha: fileSha || undefined,
      });

      setFileSha(response.data.content?.sha || '');
      
      try {
        await fetch('YOUR_N8N_WEBHOOK_URL_HERE', { method: 'POST' });
      } catch (webhookError) {
        console.error('Data saved, but failed to trigger n8n rebuild', webhookError);
      }

      alert('Successfully pushed manual changes to GitHub!');
    } catch (error) {
      console.error('Failed to save', error);
      alert('Failed to save to GitHub. Check console for details.');
    } finally {
      setLoading(false);
    }
  };

  const handleFormChange = (field: string, value: string) => {
    if (!selectedEvent) return;
    
    if (field === 'venueName') {
      setSelectedEvent({ ...selectedEvent, venue: { ...selectedEvent.venue, name: value } });
    } else if (field === 'venueAddress') {
      setSelectedEvent({ ...selectedEvent, venue: { ...selectedEvent.venue, address: value } });
    } else {
      setSelectedEvent({ ...selectedEvent, [field]: value });
    }
  };

  const handleDateTimeChange = (type: 'date' | 'time', value: string) => {
    if (!selectedEvent) return;
    
    let currentDate = '';
    let currentTime = '00:00';
    
    if (selectedEvent.date) {
      const d = new Date(selectedEvent.date);
      if (!isNaN(d.getTime())) {
        currentDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        currentTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      }
    }

    if (type === 'date') currentDate = value;
    if (type === 'time') currentTime = value;
    
    if (currentDate) {
      const newIsoObj = new Date(`${currentDate}T${currentTime}`);
      if (!isNaN(newIsoObj.getTime())) {
        setSelectedEvent({ ...selectedEvent, date: newIsoObj.toISOString() });
      }
    }
  };

  // --- LINEUP HANDLERS ---
  const addLineupItem = () => {
    if (!selectedEvent) return;
    const currentLineup = selectedEvent.lineup || [];
    setSelectedEvent({
      ...selectedEvent,
      lineup: [...currentLineup, { id: `band-${Date.now()}`, artist: '', stageTime: '' }]
    });
  };

  const updateLineupItem = (index: number, field: 'artist' | 'stageTime', value: string) => {
    if (!selectedEvent || !selectedEvent.lineup) return;
    const newLineup = [...selectedEvent.lineup];
    newLineup[index] = { ...newLineup[index], [field]: value };
    setSelectedEvent({ ...selectedEvent, lineup: newLineup });
  };

  const removeLineupItem = (index: number) => {
    if (!selectedEvent || !selectedEvent.lineup) return;
    const newLineup = selectedEvent.lineup.filter((_, i) => i !== index);
    setSelectedEvent({ ...selectedEvent, lineup: newLineup });
  };
  // -----------------------

  const saveLocalEvent = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEvent) return;

    setManualEvents((prev) => {
      const exists = prev.find((ev) => ev.id === selectedEvent.id);
      if (exists) {
        return prev.map((ev) => (ev.id === selectedEvent.id ? selectedEvent : ev));
      }
      return [...prev, selectedEvent];
    });
    
    setSelectedEvent(null);
  };

  const deleteLocalEvent = () => {
    if (!selectedEvent) return;
    if (window.confirm('Delete this event from manual overrides?')) {
      setManualEvents((prev) => prev.filter((ev) => ev.id !== selectedEvent.id));
      setSelectedEvent(null);
    }
  };

  const addNewEvent = () => {
    setSelectedEvent({
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
      addedDate: new Date().toISOString()
    });
  };

  const formatListDate = (isoString: string) => {
    if (!isoString) return 'No Date';
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return 'Invalid Date';
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  };

  const getFormDate = (isoString: string) => {
    if (!isoString) return '';
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const getFormTime = (isoString: string) => {
    if (!isoString) return '';
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  const eventMap = new Map<string, Event>();
  const safeApiEvents = Array.isArray(apiEvents) ? apiEvents : [];
  const safeManualEvents = Array.isArray(manualEvents) ? manualEvents : [];

  safeApiEvents.forEach(ev => eventMap.set(ev.id, ev));
  safeManualEvents.forEach(ev => eventMap.set(ev.id, ev)); 
  
  const displayEvents = Array.from(eventMap.values()).sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );

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
        </form>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', height: '100vh', fontFamily: 'sans-serif' }}>
      {/* LEFT COLUMN: LIST */}
      <div style={{ borderRight: '1px solid #ccc', padding: '1rem', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem', alignItems: 'center' }}>
          <h2>All Events ({displayEvents.length})</h2>
          <div>
            <button onClick={addNewEvent} style={{ marginRight: '0.5rem', padding: '0.5rem' }}>+ New Event</button>
            <button onClick={saveToGitHub} disabled={loading} style={{ padding: '0.5rem', backgroundColor: '#ff535b', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
              {loading ? 'Saving...' : 'Push to GitHub'}
            </button>
          </div>
        </div>
        
        {displayEvents.map((ev) => {
          const isManual = manualEvents.some(m => m.id === ev.id);
          return (
            <div 
              key={ev.id} 
              onClick={() => setSelectedEvent(ev)}
              style={{ 
                padding: '0.75rem', 
                border: '1px solid #ddd', 
                marginBottom: '0.5rem', 
                cursor: 'pointer',
                backgroundColor: selectedEvent?.id === ev.id ? '#e9ecef' : 'transparent',
                borderLeft: isManual ? '4px solid #ff535b' : '1px solid #ddd'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong>{ev.title}</strong>
                {isManual && <span style={{ fontSize: '0.7rem', color: '#ff535b', fontWeight: 'bold' }}>EDITED</span>}
              </div>
              <div style={{ fontSize: '0.85rem', color: '#666', marginTop: '0.25rem' }}>
                {formatListDate(ev.date)} @ {ev.venue?.name || 'Unknown'}
              </div>
            </div>
          );
        })}
      </div>

      {/* RIGHT COLUMN: FORM */}
      <div style={{ padding: '1rem', overflowY: 'auto', backgroundColor: '#f8f9fa' }}>
        {selectedEvent ? (
          <form onSubmit={saveLocalEvent} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', backgroundColor: 'white', padding: '1.5rem', borderRadius: '8px', border: '1px solid #dee2e6' }}>
            <h2>{selectedEvent.id.startsWith('manual-') && !manualEvents.find(e => e.id === selectedEvent.id) ? 'Create New Event' : 'Edit Event Data'}</h2>
            
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontWeight: 'bold' }}>
              Title:
              <input type="text" value={selectedEvent.title || ''} onChange={(e) => handleFormChange('title', e.target.value)} required style={{ padding: '0.5rem', border: '1px solid #ccc', borderRadius: '4px', fontWeight: 'normal' }} />
            </label>
            
            {/* LINEUP SECTION */}
            <div style={{ border: '1px solid #ccc', padding: '1rem', borderRadius: '4px', backgroundColor: '#fdfdfd' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <strong style={{ fontSize: '0.9rem' }}>Lineup / Warm-up Bands</strong>
                <button type="button" onClick={addLineupItem} style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem', cursor: 'pointer', backgroundColor: '#e9ecef', border: '1px solid #ccc', borderRadius: '4px' }}>+ Add Band</button>
              </div>
              
              {(selectedEvent.lineup || []).map((band, index) => (
                <div key={band.id} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', alignItems: 'center' }}>
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
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontWeight: 'bold' }}>
                Date:
                <input type="date" value={getFormDate(selectedEvent.date)} onChange={(e) => handleDateTimeChange('date', e.target.value)} required style={{ padding: '0.5rem', border: '1px solid #ccc', borderRadius: '4px', fontWeight: 'normal' }} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontWeight: 'bold' }}>
                Time:
                <input type="time" value={getFormTime(selectedEvent.date)} onChange={(e) => handleDateTimeChange('time', e.target.value)} required style={{ padding: '0.5rem', border: '1px solid #ccc', borderRadius: '4px', fontWeight: 'normal' }} />
              </label>
            </div>
            
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontWeight: 'bold' }}>
              Venue Name:
              <input type="text" value={selectedEvent.venue?.name || ''} onChange={(e) => handleFormChange('venueName', e.target.value)} required style={{ padding: '0.5rem', border: '1px solid #ccc', borderRadius: '4px', fontWeight: 'normal' }} />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontWeight: 'bold' }}>
              Venue Address:
              <input type="text" value={selectedEvent.venue?.address || ''} onChange={(e) => handleFormChange('venueAddress', e.target.value)} style={{ padding: '0.5rem', border: '1px solid #ccc', borderRadius: '4px', fontWeight: 'normal' }} />
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontWeight: 'bold' }}>
                Price:
                <input type="text" value={selectedEvent.price || ''} onChange={(e) => handleFormChange('price', e.target.value)} style={{ padding: '0.5rem', border: '1px solid #ccc', borderRadius: '4px', fontWeight: 'normal' }} />
              </label>
              
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontWeight: 'bold' }}>
                Age Limit:
                <input type="text" value={selectedEvent.ageLimit || ''} onChange={(e) => handleFormChange('ageLimit', e.target.value)} style={{ padding: '0.5rem', border: '1px solid #ccc', borderRadius: '4px', fontWeight: 'normal' }} />
              </label>
            </div>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontWeight: 'bold' }}>
              Ticket URL:
              <input type="url" value={selectedEvent.ticketUrl || ''} onChange={(e) => handleFormChange('ticketUrl', e.target.value)} style={{ padding: '0.5rem', border: '1px solid #ccc', borderRadius: '4px', fontWeight: 'normal' }} />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontWeight: 'bold' }}>
              Image URL:
              <input type="url" value={selectedEvent.image || ''} onChange={(e) => handleFormChange('image', e.target.value)} style={{ padding: '0.5rem', border: '1px solid #ccc', borderRadius: '4px', fontWeight: 'normal' }} />
            </label>
            
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontWeight: 'bold' }}>
              Description:
              <textarea value={selectedEvent.description || ''} onChange={(e) => handleFormChange('description', e.target.value)} rows={6} style={{ padding: '0.5rem', border: '1px solid #ccc', borderRadius: '4px', fontWeight: 'normal' }} />
            </label>
            
            <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', gap: '1rem' }}>
                <button type="submit" style={{ padding: '0.5rem 1rem', backgroundColor: '#333', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Save to List</button>
                <button type="button" onClick={() => setSelectedEvent(null)} style={{ padding: '0.5rem 1rem', backgroundColor: '#e9ecef', color: '#333', border: '1px solid #ccc', borderRadius: '4px', cursor: 'pointer' }}>Cancel</button>
              </div>
              <button type="button" onClick={deleteLocalEvent} style={{ padding: '0.5rem 1rem', backgroundColor: '#dc3545', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Delete Event</button>
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