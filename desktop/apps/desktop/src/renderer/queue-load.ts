export async function loadQueueForCurrentTask<T>(input: {
  load: () => Promise<T>;
  isCurrent: () => boolean;
  onLoaded: (queue: T) => void;
  onError: (error: unknown) => void;
}): Promise<void> {
  try {
    const queue = await input.load();
    if (input.isCurrent()) input.onLoaded(queue);
  } catch (error) {
    if (input.isCurrent()) input.onError(error);
  }
}
