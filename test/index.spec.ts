import { KeyValueCache, KeyValueCacheAdapter } from "../src";

type TestParams = { id: string };

const MOCK_PREFIX = "prefix";
const MOCK_FILE_PATH = "/mock/path/image.jpg";
const MOCK_FILE_DOES_NOT_EXIST_PATH = "/does/not/exist/image.jpg";
const MOCK_NOT_FOUND_KEY = "not-found";
const MOCK_NULL_VALUE_KEY = "null-value";

function getTimestamp(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

const EVICTION_MILLIS = 1000 * 60 * 60 * 24; // 1 day
const MAX_ENTRIES = 100;
const MAX_CACHE_SIZE = 10_000_000;

describe("KeyValueCache", () => {
  let adapter: jest.Mocked<KeyValueCacheAdapter<TestParams>>;
  let cache: KeyValueCache<TestParams>;
  let dictionary: Record<string, string> = {};

  beforeEach(() => {
    adapter = {
      prefix: MOCK_PREFIX,
      evictionMillis: EVICTION_MILLIS,
      maxEntries: MAX_ENTRIES,
      maxCacheSize: MAX_CACHE_SIZE,

      getValueForKey: jest
        .fn()
        .mockImplementation(async (key: string): Promise<string | null> => {
          const result = key === MOCK_NULL_VALUE_KEY ? null : dictionary[key];
          return Promise.resolve(result);
        }),
      setValueForKey: jest
        .fn()
        .mockImplementation(
          async (key: string, value: string): Promise<void> => {
            dictionary[key] = value;
            return Promise.resolve();
          }
        ),
      deleteKeyValue: jest
        .fn()
        .mockImplementation(async (key: string): Promise<void> => {
          delete dictionary[key];
          return Promise.resolve();
        }),
      getAllKeys: jest.fn().mockImplementation(async (): Promise<string[]> => {
        return Promise.resolve(Object.keys(dictionary));
      }),
      getKeyFor: jest
        .fn()
        .mockImplementation(
          async (params: TestParams): Promise<string | null> => {
            return Promise.resolve(
              params.id === MOCK_NOT_FOUND_KEY ? null : params.id
            );
          }
        ),
      fileExists: jest
        .fn()
        .mockImplementation(async (path: string): Promise<boolean> => {
          return Promise.resolve(path !== MOCK_FILE_DOES_NOT_EXIST_PATH);
        }),
      fileUnlink: jest
        .fn()
        .mockImplementation(async (path: string): Promise<void> => {
          if (path === MOCK_FILE_PATH) {
            return Promise.resolve();
          }
          return Promise.reject(new Error("File does not exist"));
        }),
      fileSize: jest
        .fn()
        .mockImplementation(async (_path: string): Promise<number> => {
          return Promise.resolve(1234);
        }),
    };

    cache = new KeyValueCache(adapter);
  });

  afterEach(() => {
    dictionary = {};
  });

  it("get awaits to boot", async () => {
    let getAllKeysTimestamp = 0;
    let getKeyForTimestamp = 0;

    let signalResolve!: () => void;
    const signal = new Promise<void>(resolve => {
      signalResolve = resolve;
    });

    adapter.getAllKeys = jest.fn().mockImplementation(async () => {
      await signal;
      getAllKeysTimestamp = getTimestamp();
      console.log("getAllKeysTimestamp", getAllKeysTimestamp);
      return [];
    });

    adapter.getKeyFor = jest
      .fn()
      .mockImplementation(async (_params: TestParams) => {
        getKeyForTimestamp = getTimestamp();
        console.log("getKeyForTimestamp", getKeyForTimestamp);
        const result = await Promise.resolve(null);
        return result;
      });

    const newCache = new KeyValueCache(adapter); // starts boot
    const getPromise = newCache.get({ id: "test" });

    signalResolve();

    const result = await getPromise;

    expect(result).toBeNull();
    expect(getAllKeysTimestamp).toBeGreaterThan(0);
    expect(getKeyForTimestamp).toBeGreaterThan(0);
    expect(getKeyForTimestamp).toBeGreaterThan(getAllKeysTimestamp);
  });

  it("get returns null if key is falsy", async () => {
    const result = await cache.get({ id: MOCK_NOT_FOUND_KEY });
    expect(result).toBeNull();
  });

  it("get returns null if value is falsy", async () => {
    const result = await cache.get({ id: MOCK_NULL_VALUE_KEY });
    expect(result).toBeNull();
  });

  it("get returns null and deletes key if value is invalid JSON", async () => {
    const invalidJson = "not-json";
    const invalidJsonKey = "invalid-json";
    dictionary[invalidJsonKey] = invalidJson;

    const result = await cache.get({ id: invalidJsonKey });
    console.log("result", result);
    expect(result).toBeNull();
    const keys = Object.keys(dictionary);
    expect(keys).not.toContain(invalidJsonKey);
  });

  it("get returns null and deletes key if file does not exist", async () => {
    const value = `{ "filePath": "${MOCK_FILE_DOES_NOT_EXIST_PATH}", "lastAccessed": 1722339600000 }`;
    const key = "TheKey";
    dictionary[key] = value;

    const result = await cache.get({ id: key });
    console.log("result", result);
    expect(result).toBeNull();
    const keys = Object.keys(dictionary);
    expect(keys).not.toContain(key);
  });

  it("get returns null and deletes key if evictionMillis is exceeded", async () => {
    const lastAccessed = Date.now() - EVICTION_MILLIS - 1;
    const value = `{ "filePath": "${MOCK_FILE_PATH}", "lastAccessed": ${lastAccessed} }`;
    const key = "TheKey";
    dictionary[key] = value;

    const result = await cache.get({ id: key });
    console.log("result", result);
    expect(result).toBeNull();
    const keys = Object.keys(dictionary);
    expect(keys).not.toContain(key);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(adapter.fileUnlink).toHaveBeenCalledWith(MOCK_FILE_PATH);
  });

  it("get returns when all conditions are met", async () => {
    const lastAccessed = Date.now() - 1;
    const value = `{ "filePath": "${MOCK_FILE_PATH}", "lastAccessed": ${lastAccessed} }`;
    const key = "TheKey";
    dictionary[key] = value;

    const result = await cache.get({ id: key });
    console.log("result", result);
    expect(result).toBe(MOCK_FILE_PATH);
    const keys = Object.keys(dictionary);
    expect(keys).toContain(key);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(adapter.fileUnlink).not.toHaveBeenCalled();
  });

  it("put awaits to boot", async () => {
    let getAllKeysTimestamp = 0;
    let getKeyForTimestamp = 0;

    let signalResolve!: () => void;
    const signal = new Promise<void>(resolve => {
      signalResolve = resolve;
    });

    adapter.getAllKeys = jest.fn().mockImplementation(async () => {
      await signal;
      getAllKeysTimestamp = getTimestamp();
      console.log("getAllKeysTimestamp", getAllKeysTimestamp);
      return [];
    });

    adapter.getKeyFor = jest
      .fn()
      .mockImplementation(async (_params: TestParams) => {
        getKeyForTimestamp = getTimestamp();
        console.log("getKeyForTimestamp", getKeyForTimestamp);
        const result = await Promise.resolve(null);
        return result;
      });

    const newCache = new KeyValueCache(adapter); // starts boot
    const putPromise = newCache.put({ id: "test" }, MOCK_FILE_PATH);

    signalResolve();

    const result = await putPromise;

    expect(result).toBe(false);
    expect(getAllKeysTimestamp).toBeGreaterThan(0);
    expect(getKeyForTimestamp).toBeGreaterThan(0);
    expect(getKeyForTimestamp).toBeGreaterThan(getAllKeysTimestamp);
  });

  it("put returns false if key is falsy", async () => {
    const result = await cache.put({ id: MOCK_NOT_FOUND_KEY }, MOCK_FILE_PATH);
    expect(result).toBe(false);
  });

  it("put returns true when all conditions are met", async () => {
    const key = "TheKey";
    const result = await cache.put({ id: key }, MOCK_FILE_PATH);
    expect(result).toBe(true);
    expect(dictionary[key]).toContain(`"filePath":"${MOCK_FILE_PATH}"`);
    expect(dictionary[key]).toContain('"lastAccessed"');
  });

  it("put cleans up count when maxEntries is reached", async () => {
    const lastAccessed = Date.now() - EVICTION_MILLIS - 1;
    const value = `{ "filePath": "${MOCK_FILE_PATH}", "lastAccessed": ${lastAccessed} }`;
    const oldKey = `${MOCK_PREFIX}:OldKey`;
    dictionary[oldKey] = value;

    adapter.maxEntries = 1;
    const newCache = new KeyValueCache(adapter);

    const newKey = `${MOCK_PREFIX}:NewKey`;
    const result = await newCache.put({ id: newKey }, MOCK_FILE_PATH);
    expect(result).toBe(true);
    expect(dictionary[newKey]).toContain(`"filePath":"${MOCK_FILE_PATH}"`);
    expect(dictionary[newKey]).toContain('"lastAccessed"');
    expect(dictionary[oldKey]).toBeUndefined();
  });

  it("put cleans up disk when maxCacheSize is reached", async () => {
    const lastAccessed = Date.now() - EVICTION_MILLIS - 1;
    const value = `{ "filePath": "${MOCK_FILE_PATH}", "lastAccessed": ${lastAccessed} }`;
    const oldKey = `${MOCK_PREFIX}:OldKey`;
    dictionary[oldKey] = value;

    adapter.maxCacheSize = 1000;
    adapter.fileSize = jest
      .fn()
      .mockImplementation(async (_path: string): Promise<number> => {
        return Promise.resolve(1000);
      });
    const newCache = new KeyValueCache(adapter);

    const newKey = `${MOCK_PREFIX}:NewKey`;
    const result = await newCache.put({ id: newKey }, MOCK_FILE_PATH);
    expect(result).toBe(true);
    expect(dictionary[newKey]).toContain(`"filePath":"${MOCK_FILE_PATH}"`);
    expect(dictionary[newKey]).toContain('"lastAccessed"');
    expect(dictionary[oldKey]).toBeUndefined();
  });
});
