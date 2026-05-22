export interface TranscriptEntry {
  time: Date;
  language: string | null;
  text: string;
}

export class Transcript {
  private entries: TranscriptEntry[] = [];
  constructor(private list: HTMLUListElement) {}

  add(entry: TranscriptEntry) {
    this.entries.push(entry);
    const li = document.createElement('li');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const time = document.createElement('span');
    time.textContent = entry.time.toLocaleTimeString();
    const src = document.createElement('span');
    src.className = 'src';
    src.textContent = entry.language ?? '??';
    meta.append(time, src);
    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = entry.text;
    li.append(meta, text);
    this.list.append(li);
    // Auto-scroll to newest.
    this.list.scrollTop = this.list.scrollHeight;
  }

  clear() {
    this.entries = [];
    this.list.innerHTML = '';
  }

  toText(): string {
    return this.entries
      .map((e) => `[${e.time.toISOString()}] [${e.language ?? '??'}] ${e.text}`)
      .join('\n');
  }
}
