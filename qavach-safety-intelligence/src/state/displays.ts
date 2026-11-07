import { createStore, useStore } from '../lib/persist';

/** A screen or set of screens in a room that a video wall can be cast to. `screens` holds, left to right and top to bottom,
 *  the video wall each screen shows (null when it shows nothing from this console). */
export interface Display {
  id: string;
  room: string;
  name: string;
  cols: number;
  rows: number;
  size: string;
  online: boolean;
  screens: (string | null)[];
  takeover: boolean;
  sound: boolean;
  until: 'never' | 'shift' | '1h' | '4h';
}

const blank = (n: number) => Array.from({ length: n }, () => null as string | null);

export const displayStore = createStore<Display[]>('displays', () => [
  { id: 'd-main-a', room: 'Main control room', name: 'Wall A', cols: 3, rows: 2, size: '55-inch', online: true, screens: blank(6), takeover: true, sound: false, until: 'never' },
  { id: 'd-main-b', room: 'Main control room', name: 'Wall B', cols: 2, rows: 2, size: '55-inch', online: true, screens: ['w-quay', 'w-quay', 'w-quay', 'w-quay'], takeover: true, sound: false, until: 'never' },
  { id: 'd-hse-wall', room: 'HSE control room', name: 'Video wall', cols: 2, rows: 2, size: '49-inch', online: true, screens: ['w-hse', 'w-hse', 'w-hse', 'w-hse'], takeover: true, sound: true, until: 'never' },
  { id: 'd-hse-tv', room: 'HSE control room', name: 'Briefing TV', cols: 1, rows: 1, size: '65-inch', online: true, screens: blank(1), takeover: false, sound: false, until: 'never' },
  { id: 'd-gate', room: 'Gate office', name: 'Gate TV', cols: 1, rows: 1, size: '55-inch', online: true, screens: ['w-yard'], takeover: true, sound: false, until: 'never' },
  { id: 'd-hut', room: 'Berth 2 supervisor hut', name: 'Hut TV', cols: 1, rows: 1, size: '43-inch', online: false, screens: blank(1), takeover: true, sound: false, until: 'never' },
]);

export const useDisplays = () => useStore(displayStore);
export const saveDisplay = (d: Display) => displayStore.set((all) => all.map((x) => (x.id === d.id ? d : x)));
