/** Demo videos that ship with the detection service (backend/samples). Picking one in camera set-up connects the camera to
 *  that video, which plays in a loop like a camera that is always on. The id is the file name in backend/samples. `label` is the
 *  name in the Sample Video dropdown; `cameraName` is what the camera is called once it is set up (a name a port would use),
 *  and `fileName` the clip name shown for it. */
export const SAMPLE_VIDEOS = [
  { id: '5a3b1e000005', label: 'Fire and Smoke Detection Sample', cameraName: 'Berth 4 · deck fire watch', fileName: 'berth-4-deck-fire-watch.mp4' },
  { id: '5a3b1e000006', label: 'Fire and Smoke Detection Sample 2', cameraName: 'Berth 5 · deck fire watch', fileName: 'berth-5-deck-fire-watch.mp4' },
  { id: '5a3b1e000007', label: 'Intrusion Detection Sample', cameraName: 'Berth 3 · access gate', fileName: 'berth-3-access-gate.mp4' },
  { id: '5a3b1e000004', label: 'Fire and Smoke Detection Sample 3', cameraName: 'Berth 6 · deck fire watch', fileName: 'berth-6-deck-fire-watch.mp4' },
] as const;
