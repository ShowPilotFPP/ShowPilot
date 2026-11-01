// ============================================================
// Fake show player: talks to ShowPilot exactly like the FPP plugin or
// another show player's built-in client does, but on demand instead of in real
// time. It never decides "this was a vote" or "this was a request": it asks
// ShowPilot what to play (GET /api/plugin/state), plays it (POST /playing),
// and ShowPilot works out the rest from what it handed out, the same as on a
// real show night.
// ============================================================
'use strict';

class ShowPlayer {
  constructor(sp) {
    this.sp = sp;
    this.playlist = [];
    this.playing = null;
    this.lastAnswer = null;
  }

  async call(method, path, body) {
    const r = await fetch(this.sp.base + '/api/plugin' + path, {
      method,
      headers: { authorization: 'Bearer ' + this.sp.showToken, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    if (r.status >= 400) throw new Error(`show player ${method} ${path} → HTTP ${r.status}: ${text.slice(0, 200)}`);
    return json;
  }

  // The playlist the show player offers to viewers ("sync").
  async sync(names) {
    this.playlist = names.slice();
    return this.call('POST', '/sync-sequences', {
      playlistName: 'Show',
      sequences: names.map((name, i) => ({ name, playlistIndex: i + 1 })),
    });
  }

  // Start a song (or '' for "nothing playing").
  async play(name) {
    this.playing = name || null;
    await this.call('POST', '/playing', { sequence: name || '', seconds_played: 0 });
    // Up Next for the schedule tier: the song after this one in the playlist.
    const i = this.playlist.indexOf(name);
    if (name && i >= 0) {
      const next = this.playlist[(i + 1) % this.playlist.length];
      await this.call('POST', '/next', { sequence: next }).catch(() => {});
    }
  }

  // What ShowPilot wants played next (null = follow the schedule).
  async ask() {
    const st = await this.call('GET', '/state');
    this.lastAnswer = st;
    if (st.psa && st.psa.sequence) return { name: st.psa.sequence, why: 'psa', state: st };
    if (st.mode === 'VOTING' && st.winningVote) return { name: st.winningVote.sequence, why: 'vote', state: st };
    if (st.mode === 'JUKEBOX' && st.nextRequest) return { name: st.nextRequest.sequence, why: 'request', state: st };
    if (st.mode === 'RACE' && st.raceWinner) return { name: st.raceWinner.sequence, why: 'race', state: st };
    return { name: null, why: 'schedule', state: st };
  }

  // Finish the current song: play whatever ShowPilot asks for, otherwise the
  // next song in the playlist.
  async playNext() {
    const a = await this.ask();
    let name = a.name;
    if (!name) {
      const i = this.playlist.indexOf(this.playing);
      name = this.playlist[(i + 1) % this.playlist.length];
    }
    await this.play(name);
    return { name, why: a.why };
  }

  // FPP command equivalents.
  setMode(mode) { return this.call('POST', '/viewer-mode', { mode }); }
  clearQueue() { return this.call('POST', '/queue/clear', {}); }
  setCategory(name, enabled) { return this.call('POST', '/category', { name, enabled }); }
}

module.exports = { ShowPlayer };
