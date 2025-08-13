import { CacheOptions, getCache, KeyValueCache, parseValueEntry } from "../src";

type TestParams = { id: string };

const MOCK_PREFIX = "prefix";
const MOCK_FILE_PATH = "/mock/path/image.jpg";
const MOCK_FILE_DOES_NOT_EXIST_PATH = "/does/not/exist/image.jpg";
const MOCK_NOT_FOUND_KEY = "not-found";
const MOCK_NULL_VALUE_KEY = "null-value";
const MOCK_SET_DELETE_FALSE_KEY = "set-delete-false";
const MOCK_FILE_SIZE = 1000;

function getTimestamp(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

const EVICTION_MILLIS = 1000 * 60 * 60 * 24; // 1 day
const MAX_ENTRIES = 100;
const MAX_CACHE_SIZE = 10_000_000;

describe("KeyValueCache", () => {
  function getDefaultCache(options?: TestCacheOptions<TestParams>) {
    const defaultOptions = {
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
          async (key: string, value: string): Promise<boolean> => {
            if (key === MOCK_SET_DELETE_FALSE_KEY) {
              return Promise.resolve(false);
            }
            dictionary[key] = value;
            return Promise.resolve(true);
          }
        ),

      deleteKeyValue: jest
        .fn()
        .mockImplementation(async (key: string): Promise<boolean> => {
          if (key === MOCK_SET_DELETE_FALSE_KEY) {
            return Promise.resolve(false);
          }
          delete dictionary[key];
          return Promise.resolve(true);
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
        .mockImplementation(async (path: string): Promise<boolean> => {
          if (path === MOCK_FILE_PATH) {
            return Promise.resolve(true);
          }
          return Promise.resolve(false);
        }),

      fileSize: jest
        .fn()
        .mockImplementation(async (_path: string): Promise<number> => {
          return Promise.resolve(MOCK_FILE_SIZE);
        }),
    };

    return getCache({
      prefix: options?.prefix ?? defaultOptions.prefix,
      evictionMillis: options?.evictionMillis ?? defaultOptions.evictionMillis,
      maxEntries: options?.maxEntries ?? defaultOptions.maxEntries,
      maxCacheSize: options?.maxCacheSize ?? defaultOptions.maxCacheSize,
      getValue: options?.getValue ?? defaultOptions.getValueForKey,
      setValue: options?.setValue ?? defaultOptions.setValueForKey,
      delete: options?.delete ?? defaultOptions.deleteKeyValue,
      getAllKeys: options?.getAllKeys ?? defaultOptions.getAllKeys,
      getKeyFor: options?.getKeyFor ?? defaultOptions.getKeyFor,
      fileExists: options?.fileExists ?? defaultOptions.fileExists,
      fileUnlink: options?.fileUnlink ?? defaultOptions.fileUnlink,
      fileSize: options?.fileSize ?? defaultOptions.fileSize,
    });
  }

  let cache: KeyValueCache<TestParams>;
  let dictionary: Record<string, string> = {};

  beforeEach(() => {
    cache = getDefaultCache();
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

    const getAllKeys = jest.fn().mockImplementation(async () => {
      await signal;
      getAllKeysTimestamp = getTimestamp();
      console.log("getAllKeysTimestamp", getAllKeysTimestamp);
      return [];
    });

    const getKeyFor = jest
      .fn()
      .mockImplementation(async (_params: TestParams) => {
        getKeyForTimestamp = getTimestamp();
        console.log("getKeyForTimestamp", getKeyForTimestamp);
        const result = await Promise.resolve(null);
        return result;
      });

    const newCache = getDefaultCache({ getAllKeys, getKeyFor }); // starts boot
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

    const fileUnlink = jest
      .fn()
      .mockImplementation(async (_path: string): Promise<boolean> => {
        return Promise.resolve(true);
      });
    const newCache = getDefaultCache({ fileUnlink });

    const result = await newCache.get({ id: key });
    console.log("result", result);
    expect(result).toBeNull();
    const keys = Object.keys(dictionary);
    expect(keys).not.toContain(key);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(fileUnlink).toHaveBeenCalledWith(MOCK_FILE_PATH);
  });

  it("get returns when all conditions are met", async () => {
    const lastAccessed = Date.now() - 1;
    const value = `{ "filePath": "${MOCK_FILE_PATH}", "lastAccessed": ${lastAccessed} }`;
    const key = `${MOCK_PREFIX}:TheKey`;
    dictionary[key] = value;

    const fileUnlink = jest
      .fn()
      .mockImplementation(async (_path: string): Promise<boolean> => {
        return Promise.resolve(true);
      });
    const newCache = getDefaultCache({ fileUnlink });

    const result = await newCache.get({ id: key });
    console.log("result", result);
    expect(result).toBe(MOCK_FILE_PATH);
    const keys = Object.keys(dictionary);
    expect(keys).toContain(key);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(fileUnlink).not.toHaveBeenCalled();
  });

  it("put awaits to boot", async () => {
    let getAllKeysTimestamp = 0;
    let getKeyForTimestamp = 0;

    let signalResolve!: () => void;
    const signal = new Promise<void>(resolve => {
      signalResolve = resolve;
    });

    const getAllKeys = jest.fn().mockImplementation(async () => {
      await signal;
      getAllKeysTimestamp = getTimestamp();
      console.log("getAllKeysTimestamp", getAllKeysTimestamp);
      return [];
    });

    const getKeyFor = jest
      .fn()
      .mockImplementation(async (_params: TestParams) => {
        getKeyForTimestamp = getTimestamp();
        console.log("getKeyForTimestamp", getKeyForTimestamp);
        const result = await Promise.resolve(null);
        return result;
      });

    const newCache = getDefaultCache({ getAllKeys, getKeyFor }); // starts boot
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

  it("put returns false if setValueForKey returns false", async () => {
    const result = await cache.put(
      { id: MOCK_SET_DELETE_FALSE_KEY },
      MOCK_FILE_PATH
    );
    expect(result).toBe(false);
  });

  it("put does not increment diskSize if fileExists returns false", async () => {
    const key = "TheKey";
    const diskSize = await cache.getCurrentDiskSize();
    const result = await cache.put({ id: key }, MOCK_FILE_DOES_NOT_EXIST_PATH);
    expect(result).toBe(true);
    expect(dictionary[key]).toContain(
      `"filePath":"${MOCK_FILE_DOES_NOT_EXIST_PATH}"`
    );
    expect(dictionary[key]).toContain('"lastAccessed"');
    expect(await cache.getCurrentEntriesCount()).toBe(1);
    expect(await cache.getCurrentDiskSize()).toBe(diskSize);
  });

  it("put returns true when all conditions are met", async () => {
    const key = "TheKey";
    const result = await cache.put({ id: key }, MOCK_FILE_PATH);
    expect(result).toBe(true);
    expect(dictionary[key]).toContain(`"filePath":"${MOCK_FILE_PATH}"`);
    expect(dictionary[key]).toContain('"lastAccessed"');
    expect(await cache.getCurrentEntriesCount()).toBe(1);
    expect(await cache.getCurrentDiskSize()).toBe(MOCK_FILE_SIZE);
  });

  it("put cleans up count when maxEntries is reached", async () => {
    const lastAccessed = Date.now() - EVICTION_MILLIS - 1;
    const value = `{ "filePath": "${MOCK_FILE_PATH}", "lastAccessed": ${lastAccessed} }`;
    const oldKey = `${MOCK_PREFIX}:OldKey`;
    dictionary[oldKey] = value;

    const newCache = getDefaultCache({ maxEntries: 1 });

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

    const maxCacheSize = 1000;
    const fileSize = jest
      .fn()
      .mockImplementation(async (_path: string): Promise<number> => {
        return Promise.resolve(1000);
      });
    const newCache = getDefaultCache({ maxCacheSize, fileSize });

    const newKey = `${MOCK_PREFIX}:NewKey`;
    const result = await newCache.put({ id: newKey }, MOCK_FILE_PATH);
    expect(result).toBe(true);
    expect(dictionary[newKey]).toContain(`"filePath":"${MOCK_FILE_PATH}"`);
    expect(dictionary[newKey]).toContain('"lastAccessed"');
    expect(dictionary[oldKey]).toBeUndefined();
  });

  it("delete awaits to boot", async () => {
    let getAllKeysTimestamp = 0;
    let getKeyForTimestamp = 0;

    let signalResolve!: () => void;
    const signal = new Promise<void>(resolve => {
      signalResolve = resolve;
    });

    const getAllKeys = jest.fn().mockImplementation(async () => {
      await signal;
      getAllKeysTimestamp = getTimestamp();
      console.log("getAllKeysTimestamp", getAllKeysTimestamp);
      return [];
    });

    const getKeyFor = jest
      .fn()
      .mockImplementation(async (_params: TestParams) => {
        getKeyForTimestamp = getTimestamp();
        console.log("getKeyForTimestamp", getKeyForTimestamp);
        const result = await Promise.resolve(null);
        return result;
      });

    const newCache = getDefaultCache({ getAllKeys, getKeyFor }); // starts boot
    const deletePromise = newCache.delete({ id: "test" });

    signalResolve();

    const result = await deletePromise;

    expect(result).toBe(false);
    expect(getAllKeysTimestamp).toBeGreaterThan(0);
    expect(getKeyForTimestamp).toBeGreaterThan(0);
    expect(getKeyForTimestamp).toBeGreaterThan(getAllKeysTimestamp);
  });

  it("delete returns false if key is falsy", async () => {
    const result = await cache.delete({ id: MOCK_NOT_FOUND_KEY });
    expect(result).toBe(false);
  });

  it("delete returns false if value is falsy", async () => {
    const result = await cache.delete({ id: MOCK_NULL_VALUE_KEY });
    expect(result).toBe(false);
  });

  it("delete returns false if deleteKeyValue returns false", async () => {
    dictionary[MOCK_SET_DELETE_FALSE_KEY] = "value";
    const result = await cache.delete({ id: MOCK_SET_DELETE_FALSE_KEY });
    expect(result).toBe(false);
  });

  it("delete does not decrement diskSize if fileExists returns false", async () => {
    const key = `${MOCK_PREFIX}:TheKey`;
    await cache.put({ id: key }, MOCK_FILE_DOES_NOT_EXIST_PATH);
    const diskSize = await cache.getCurrentDiskSize();
    const result = await cache.delete({ id: key });
    expect(result).toBe(true);
    expect(dictionary[key]).toBeUndefined();
    expect(await cache.getCurrentEntriesCount()).toBe(0);
    expect(await cache.getCurrentDiskSize()).toBe(diskSize);
  });

  it("delete decrements diskSize only if fileUnlink returns true", async () => {
    const lastAccessed = Date.now() - 1;
    const value = `{ "filePath": "${MOCK_FILE_PATH}", "lastAccessed": ${lastAccessed} }`;
    const key = `${MOCK_PREFIX}:TheKey`;
    dictionary[key] = value;
    const fileUnlink = jest
      .fn()
      .mockImplementation(async (_path: string): Promise<boolean> => {
        return Promise.resolve(false);
      });

    const newCache = getDefaultCache({ fileUnlink }); // New cache to account for the entry added above.
    const diskSize = await newCache.getCurrentDiskSize();
    const result = await newCache.delete({ id: key });

    expect(result).toBe(true);
    expect(dictionary[key]).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(fileUnlink).toHaveBeenCalledWith(MOCK_FILE_PATH);
    expect(await newCache.getCurrentEntriesCount()).toBe(0);
    expect(await newCache.getCurrentDiskSize()).toBe(diskSize);
  });

  it("delete returns true and unlinks file when all conditions are met", async () => {
    const lastAccessed = Date.now() - 1;
    const value = `{ "filePath": "${MOCK_FILE_PATH}", "lastAccessed": ${lastAccessed} }`;
    const key = `${MOCK_PREFIX}:TheKey`;
    dictionary[key] = value;

    const fileUnlink = jest
      .fn()
      .mockImplementation(async (_path: string): Promise<boolean> => {
        return Promise.resolve(true);
      });

    const newCache = getDefaultCache({ fileUnlink }); // New cache to account for the entry added above.

    const result = await newCache.delete({ id: key });

    expect(result).toBe(true);
    expect(dictionary[key]).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(fileUnlink).toHaveBeenCalledWith(MOCK_FILE_PATH);
    expect(await newCache.getCurrentEntriesCount()).toBe(0);
    expect(await newCache.getCurrentDiskSize()).toBe(0);
  });

  it("cleanExpiredEntries awaits to boot", async () => {
    const lastAccessed = Date.now() - 1;
    const value = `{ "filePath": "${MOCK_FILE_PATH}", "lastAccessed": ${lastAccessed} }`;
    const key = `${MOCK_PREFIX}:TheKey`;
    dictionary[key] = value;

    let getAllKeysTimestamp = 0;
    let getKeyForTimestamp = 0;

    let signalResolve!: () => void;
    const signal = new Promise<void>(resolve => {
      signalResolve = resolve;
    });

    const getAllKeys = jest.fn().mockImplementation(async () => {
      await signal;
      getAllKeysTimestamp = getTimestamp();
      console.log("getAllKeysTimestamp", getAllKeysTimestamp);
      return Object.keys(dictionary);
    });

    const getValueForKey = jest.fn().mockImplementation(async (key: string) => {
      getKeyForTimestamp = getTimestamp();
      console.log("getKeyForTimestamp", getKeyForTimestamp);
      const result = key === MOCK_NULL_VALUE_KEY ? null : dictionary[key];
      return Promise.resolve(result);
    });

    const newCache = getDefaultCache({ getAllKeys, getValue: getValueForKey }); // starts boot
    const cleanExpiredEntriesPromise = newCache.cleanExpiredEntries();

    signalResolve();

    const result = await cleanExpiredEntriesPromise;

    expect(result).toBe(false);
    expect(getAllKeysTimestamp).toBeGreaterThan(0);
    expect(getKeyForTimestamp).toBeGreaterThan(0);
    expect(getKeyForTimestamp).toBeGreaterThan(getAllKeysTimestamp);
  });

  it("cleanExpiredEntries does not clean up entries count if deleteKeyValue returns false", async () => {
    const lastAccessed = Date.now() - EVICTION_MILLIS - 1;
    const value = `{ "filePath": "${MOCK_FILE_PATH}", "lastAccessed": ${lastAccessed} }`;
    const key = `${MOCK_PREFIX}:TheKey`;
    dictionary[key] = value;

    const deleteKeyValue = jest
      .fn()
      .mockImplementation(async (_key: string): Promise<boolean> => {
        return Promise.resolve(false);
      });
    const newCache = getDefaultCache({ delete: deleteKeyValue });
    const entriesCount = await newCache.getCurrentEntriesCount();

    const result = await newCache.cleanExpiredEntries();
    expect(result).toBe(false); // false because there is one entry to clean, and it failed.
    const keys = Object.keys(dictionary);
    expect(keys).toContain(key);
    expect(await newCache.getCurrentEntriesCount()).toBe(entriesCount);
  });

  it("cleanExpiredEntries does not clean up diskSize if fileUnlink returns false", async () => {
    const lastAccessed = Date.now() - EVICTION_MILLIS - 1;
    const value = `{ "filePath": "${MOCK_FILE_PATH}", "lastAccessed": ${lastAccessed} }`;
    const key = `${MOCK_PREFIX}:TheKey`;
    dictionary[key] = value;

    const fileUnlink = jest
      .fn()
      .mockImplementation(async (_path: string): Promise<boolean> => {
        return Promise.resolve(false);
      });

    const newCache = getDefaultCache({ fileUnlink });
    const diskSize = await newCache.getCurrentDiskSize();

    const result = await newCache.cleanExpiredEntries();
    expect(result).toBe(true);
    const keys = Object.keys(dictionary);
    expect(keys).not.toContain(key);
    expect(await newCache.getCurrentEntriesCount()).toBe(0); // entries count should be decremented.
    expect(await newCache.getCurrentDiskSize()).toBe(diskSize);
  });

  it("cleanExpiredEntries does not clean up diskSize if fileExists returns false", async () => {
    const lastAccessed = Date.now() - 1;
    const value = `{ "filePath": "${MOCK_FILE_PATH}", "lastAccessed": ${lastAccessed} }`;
    const key = `${MOCK_PREFIX}:TheKey`;
    dictionary[key] = value;
    const newCache = getDefaultCache();
    const diskSize = await newCache.getCurrentDiskSize();

    const lastAccessedElapsed = Date.now() - EVICTION_MILLIS - 1;
    const valueElapsed = `{ "filePath": "${MOCK_FILE_DOES_NOT_EXIST_PATH}", "lastAccessed": ${lastAccessedElapsed} }`;
    const keyElapsed = `${MOCK_PREFIX}:TheKeyElapsed`;
    dictionary[keyElapsed] = valueElapsed;

    const result = await newCache.cleanExpiredEntries();
    expect(result).toBe(true);
    const keys = Object.keys(dictionary);
    expect(keys).toContain(key);
    expect(keys).not.toContain(keyElapsed);
    // entries count should be decremented. 0 because the second entry we injected externally, to test
    expect(await newCache.getCurrentEntriesCount()).toBe(0);
    expect(await newCache.getCurrentDiskSize()).toBe(diskSize);
  });

  it("cleanExpiredEntries cleans up expired entries", async () => {
    const lastAccessed = Date.now() - EVICTION_MILLIS - 1;
    const value = `{ "filePath": "${MOCK_FILE_PATH}", "lastAccessed": ${lastAccessed} }`;
    const key = `${MOCK_PREFIX}:TheKey`;
    dictionary[key] = value;

    const fileUnlink = jest
      .fn()
      .mockImplementation(async (_path: string): Promise<boolean> => {
        return Promise.resolve(true);
      });
    const newCache = getDefaultCache({ fileUnlink });

    const result = await newCache.cleanExpiredEntries();
    expect(result).toBe(true);
    const keys = Object.keys(dictionary);
    expect(keys).not.toContain(key);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(fileUnlink).toHaveBeenCalledWith(MOCK_FILE_PATH);
  });

  it("KeyValueCache initializes with the correct count and diskSize", async () => {
    const lastAccessed = Date.now() - 1;
    const value = `{ "filePath":"${MOCK_FILE_PATH}", "lastAccessed": ${lastAccessed} }`;
    const key = `${MOCK_PREFIX}:TheKey`;
    dictionary[key] = value;

    const valueNoFile = `{ "filePath":"${MOCK_FILE_DOES_NOT_EXIST_PATH}", "lastAccessed": ${lastAccessed} }`;
    const keyNoFile = `${MOCK_PREFIX}:TheKeyNoFile`;
    dictionary[keyNoFile] = valueNoFile;

    const newCache = getDefaultCache(); // New cache to account for the entry added above.
    const count = await newCache.getCurrentEntriesCount();
    const diskSize = await newCache.getCurrentDiskSize();

    expect(count).toBe(1); // 1 entry is ok, the inexistent file gets deleted.
    expect(diskSize).toBe(MOCK_FILE_SIZE); // Same here, the inexistent file gets deleted.

    expect(dictionary[keyNoFile]).toBeUndefined(); // The inexistent file gets deleted.
    expect(dictionary[key]).toBeDefined();
  });

  it("cleanExpiredEntries removes invalid JSON", async () => {
    const value = "INVALID_JSON";
    const key = `${MOCK_PREFIX}:TheKey`;
    dictionary[key] = value;

    const result = await cache.cleanExpiredEntries();

    expect(result).toBe(false);
    expect(await cache.getCurrentEntriesCount()).toBe(0);
    expect(await cache.getCurrentDiskSize()).toBe(0);
  });

  it("cleanExpiredEntries skips empty value", async () => {
    const key = `${MOCK_PREFIX}:TheKey`;
    dictionary[key] = "";

    const result = await cache.cleanExpiredEntries();

    expect(result).toBe(false);
    expect(await cache.getCurrentEntriesCount()).toBe(0);
    expect(await cache.getCurrentDiskSize()).toBe(0);
  });

  it("getOurDiskSize removes invalid JSON", async () => {
    const value = "INVALID_JSON";
    const key = `${MOCK_PREFIX}:TheKey`;
    dictionary[key] = value;

    // Instantiating the cache calls getOurDiskSize
    const newCache = getDefaultCache();

    expect(await newCache.getCurrentEntriesCount()).toBe(0);
    expect(await newCache.getCurrentDiskSize()).toBe(0);
  });

  it("getOurDiskSize skips empty value", async () => {
    const key = `${MOCK_PREFIX}:TheKey`;
    dictionary[key] = "";

    // Instantiating the cache calls getOurDiskSize
    const newCache = getDefaultCache();

    expect(await newCache.getCurrentEntriesCount()).toBe(1);
    expect(await newCache.getCurrentDiskSize()).toBe(0);
  });
});

describe("parseValueEntry", () => {
  const validJson = JSON.stringify({
    filePath: "/tmp/file",
    lastAccessed: 123456,
  });

  it("parses valid JSON and returns a ValueEntry", () => {
    const result = parseValueEntry(validJson);
    expect(result).toEqual({
      filePath: "/tmp/file",
      lastAccessed: 123456,
    });
  });

  it("throws on invalid JSON", () => {
    expect(() => parseValueEntry("{not valid json")).toThrow("Invalid JSON");
  });

  it("throws if not an object", () => {
    expect(() => parseValueEntry("123")).toThrow("Expected an object");
    expect(() => parseValueEntry('"string"')).toThrow("Expected an object");
    expect(() => parseValueEntry("null")).toThrow("Expected an object");
  });

  it("throws if filePath is missing or not a non-empty string", () => {
    expect(() => parseValueEntry(JSON.stringify({ lastAccessed: 1 }))).toThrow(
      "filePath must be a non-empty string"
    );
    expect(() =>
      parseValueEntry(JSON.stringify({ filePath: "", lastAccessed: 1 }))
    ).toThrow("filePath must be a non-empty string");
    expect(() =>
      parseValueEntry(JSON.stringify({ filePath: 123, lastAccessed: 1 }))
    ).toThrow("filePath must be a non-empty string");
  });

  it("throws if lastAccessed is missing or not a positive integer", () => {
    expect(() =>
      parseValueEntry(JSON.stringify({ filePath: "/tmp/file" }))
    ).toThrow("lastAccessed must be a positive integer");
    expect(() =>
      parseValueEntry(
        JSON.stringify({ filePath: "/tmp/file", lastAccessed: "abc" })
      )
    ).toThrow("lastAccessed must be a positive integer");
    expect(() =>
      parseValueEntry(
        JSON.stringify({ filePath: "/tmp/file", lastAccessed: 0 })
      )
    ).toThrow("lastAccessed must be a positive integer");
    expect(() =>
      parseValueEntry(
        JSON.stringify({ filePath: "/tmp/file", lastAccessed: -1 })
      )
    ).toThrow("lastAccessed must be a positive integer");
    expect(() =>
      parseValueEntry(
        JSON.stringify({ filePath: "/tmp/file", lastAccessed: 1.5 })
      )
    ).toThrow("lastAccessed must be a positive integer");
    expect(() =>
      parseValueEntry(
        JSON.stringify({ filePath: "/tmp/file", lastAccessed: Infinity })
      )
    ).toThrow("lastAccessed must be a positive integer");
  });
});

type TestCacheOptions<TKeyParams> = Partial<CacheOptions<TKeyParams>>;
