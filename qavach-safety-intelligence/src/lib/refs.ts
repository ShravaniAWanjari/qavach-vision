import type { QavachRecordType } from '../data/types';

/** Qavach record numbers: TYPE/SITE/MM/YY/NNNN, for example INC/MER/10/26/1407 (incident) or OBR/MER/10/26/1585 (observation). */
export const SITE_CODE = 'MER';
const PREFIX: Record<QavachRecordType, string> = { Incident: 'INC', Observation: 'OBR', 'Near miss': 'NMR' };

export function qavachRef(type: QavachRecordType, at: number, n: number) {
  const d = new Date(at);
  return `${PREFIX[type]}/${SITE_CODE}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(-2)}/${String(n).padStart(4, '0')}`;
}
