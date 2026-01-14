const DB_NAME = 'karaoke-audio-cache';
const DB_VERSION = 1;
const STORE_NAME = 'separated-tracks';

interface CachedTrack {
  id: string;
  instrumentalBlob: Blob;
  vocalsBlob?: Blob;
  createdAt: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

export async function getCachedTracks(audioUrl: string): Promise<CachedTrack | null> {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(audioUrl);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  } catch (error) {
    console.error('Error reading from IndexedDB:', error);
    return null;
  }
}

export async function saveCachedTracks(
  audioUrl: string,
  instrumentalBlob: Blob,
  vocalsBlob?: Blob
): Promise<void> {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      
      const data: CachedTrack = {
        id: audioUrl,
        instrumentalBlob,
        vocalsBlob,
        createdAt: Date.now(),
      };

      const request = store.put(data);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch (error) {
    console.error('Error saving to IndexedDB:', error);
  }
}

export async function clearOldCache(maxAgeDays = 7): Promise<void> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.openCursor();
    const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        const track = cursor.value as CachedTrack;
        if (Date.now() - track.createdAt > maxAge) {
          cursor.delete();
        }
        cursor.continue();
      }
    };
  } catch (error) {
    console.error('Error clearing old cache:', error);
  }
}
