// The measuring harness of procedure 1 (NFR-PE-01, the rows "Editor keystroke to character render" and "Yjs sync
// propagation to collaborator"; docs/plan/slice-27.md, S27-8). Nine connections that only receive, a typist that
// is a browser (./browser.ts) or, for a check without one, another connection, and the arithmetic of what each
// change took to arrive. Every time is read from one clock, the machine's, as `performance.timeOrigin +
// performance.now()`, which is the clock of the page's `event.timeStamp` as well.
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { summary, type Summary } from './stats.ts';

export const FRAGMENT = 'default';
export const clock = () => performance.timeOrigin + performance.now();

/** Writes a document of headings and paragraphs (tests/fixtures/reference-document.ts) into a fragment, as y-prosemirror does. */
export function fillFragment(
  fragment: Y.XmlFragment,
  json: { content: { type: string; attrs?: Record<string, unknown>; content?: { text: string }[] }[] },
): void {
  fragment.insert(
    0,
    json.content.map((block) => {
      const element = new Y.XmlElement(block.type);
      for (const [name, value] of Object.entries(block.attrs ?? {}))
        element.setAttribute(name, value as never);
      const text = new Y.XmlText();
      text.insert(0, block.content?.map((part) => part.text).join('') ?? '');
      element.insert(0, [text]);
      return element;
    }),
  );
}

/** The length of the text of the last paragraph: where a typist's characters are appended, and how many have arrived. */
export function tailLength(fragment: Y.XmlFragment): number {
  const last = fragment.get(fragment.length - 1);
  if (!(last instanceof Y.XmlElement)) return 0;
  return last.toArray().reduce((sum, child) => sum + (child instanceof Y.XmlText ? child.length : 0), 0);
}

export interface Connection {
  provider: HocuspocusProvider;
  document: Y.Doc;
  close(): void;
}

/**
 * A connection to one document as the account whose session `cookie` is, from the application's origin as a
 * browser sends it (the collaboration server checks both: NFR-SE-17 (c), (f)). Resolves once it is synchronised,
 * and rejects with the refusal.
 */
export async function connect(
  collabUrl: string,
  origin: string,
  cookie: string,
  documentId: string,
): Promise<Connection> {
  class Socket extends WebSocket {
    constructor(url: string | URL) {
      super(url, { headers: { cookie, origin } } as never);
    }
  }
  const socket = new HocuspocusProviderWebsocket({ url: collabUrl, WebSocketPolyfill: Socket });
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: documentId, awareness: null });
  provider.attach();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('A connection was not synchronised within 15 seconds.')),
      15_000,
    );
    provider.on('synced', () => {
      clearTimeout(timer);
      resolve();
    });
    provider.on('authenticationFailed', ({ reason }: { reason: string }) => {
      clearTimeout(timer);
      reject(new Error(`A connection was refused: ${reason}`));
    });
  });
  return {
    provider,
    document: provider.document,
    close() {
      provider.destroy();
      socket.destroy();
    },
  };
}

/** A connection that only receives, and notes the clock when each character of the typist's paragraph arrives. */
export class Receiver {
  /** arrivals[n] is the clock when the paragraph first held n characters. */
  readonly arrivals = new Map<number, number>();
  private seen: number;
  readonly base: number;
  readonly connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
    const fragment = connection.document.getXmlFragment(FRAGMENT);
    this.seen = tailLength(fragment);
    this.base = this.seen;
    connection.document.on('update', () => {
      const at = clock();
      const length = tailLength(fragment);
      for (let n = this.seen + 1; n <= length; n++) this.arrivals.set(n, at);
      this.seen = Math.max(this.seen, length);
    });
  }
}

export interface Typist {
  /** The characters already in the paragraph when typing begins. */
  base(): number;
  /** Types one character at the end of the paragraph. */
  type(char: string): Promise<void>;
  /** The clock at each key event, in order. */
  keyTimes(): Promise<number[]>;
  /** The time from each key event to the end of the frame that draws it, where the typist is a browser. */
  renderTimes(): Promise<number[]>;
  close(): Promise<void>;
}

/** A typist that is a connection: for a run without a browser, and for the test of the arithmetic. */
export function connectionTypist(connection: Connection): Typist {
  const fragment = connection.document.getXmlFragment(FRAGMENT);
  const keys: number[] = [];
  const base = tailLength(fragment);
  return {
    base: () => base,
    async type(char) {
      const last = fragment.get(fragment.length - 1) as Y.XmlElement;
      const text = last.toArray().find((child) => child instanceof Y.XmlText) as Y.XmlText;
      keys.push(clock());
      text.insert(text.length, char);
    },
    keyTimes: async () => keys,
    renderTimes: async () => [],
    close: async () => connection.close(),
  };
}

export interface Result {
  connections: number;
  rate: number;
  typed: number;
  keystroke: Summary | null;
  keystrokesNotFound: number;
  propagation: Summary;
  /** Changes a receiver never saw, over all receivers; the run is repeated unless it is 0. */
  propagationMissing: number;
  perReceiver: Summary[];
  seconds: number;
}

/** Types `keystrokes` characters at `rate` a second, and works out what each took. */
export async function measure(options: {
  receivers: Receiver[];
  typist: Typist;
  keystrokes: number;
  rate: number;
}): Promise<Result> {
  const { receivers, typist, keystrokes, rate } = options;
  const base = typist.base();
  const letters = 'abcdefghijklmnopqrstuvwxyz ';
  const began = clock();
  for (let n = 0; n < keystrokes; n++) {
    const due = began + (n * 1000) / rate;
    const wait = due - clock();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    await typist.type(letters[n % letters.length]!);
  }
  // The last changes arrive; wait for them, up to 5 seconds.
  const end = clock() + 5000;
  while (clock() < end && receivers.some((each) => !each.arrivals.has(base + keystrokes))) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const keys = await typist.keyTimes();
  const renders = await typist.renderTimes();
  const pooled: number[] = [];
  const per: number[][] = receivers.map(() => []);
  let missing = 0;
  receivers.forEach((receiver, index) => {
    for (let n = 1; n <= keystrokes; n++) {
      const arrived = receiver.arrivals.get(base + n);
      if (arrived === undefined || keys[n - 1] === undefined) {
        missing++;
        continue;
      }
      const took = arrived - keys[n - 1]!;
      pooled.push(took);
      per[index]!.push(took);
    }
  });
  if (pooled.length === 0) throw new Error('No change reached any receiver.');
  return {
    connections: receivers.length + 1,
    rate,
    typed: keystrokes,
    keystroke: renders.length > 0 ? summary(renders) : null,
    keystrokesNotFound: renders.length > 0 ? keystrokes - renders.length : 0,
    propagation: summary(pooled),
    propagationMissing: missing,
    perReceiver: per.map((values) =>
      values.length > 0 ? summary(values) : { n: 0, p50: NaN, p99: NaN, max: NaN },
    ),
    seconds: Math.round((clock() - began) / 100) / 10,
  };
}
