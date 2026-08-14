export interface WriterControls {
  stopAdministration(signal: AbortSignal): Promise<void>;
  stopIngestion(signal: AbortSignal): Promise<void>;
  stopApplication(signal: AbortSignal): Promise<void>;
  verifyNoWriters(signal: AbortSignal): Promise<boolean>;
  startApplication(signal: AbortSignal): Promise<void>;
  startIngestion(signal: AbortSignal): Promise<void>;
  startAdministration(signal: AbortSignal): Promise<void>;
}

export async function drainWriters(
  controls: WriterControls,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new Error("Writer drain cancelled");
  await controls.stopAdministration(signal);
  await controls.stopIngestion(signal);
  await controls.stopApplication(signal);
  if (!(await controls.verifyNoWriters(signal)))
    throw new Error("Writer drain could not prove a quiescent database");
}

export async function restartWriters(
  controls: WriterControls,
  signal: AbortSignal,
): Promise<void> {
  await controls.startApplication(signal);
  await controls.startIngestion(signal);
  await controls.startAdministration(signal);
}
