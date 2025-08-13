interface ValueEntry {
  filePath: string;
  lastAccessed: number;
}

export interface CacheOptions<TKeyParams> {
  prefix: string;
  evictionMillis: number;
  maxEntries: number;
  maxCacheSize: number;
  getValue: (key: string) => Promise<string | null>;
  setValue: (key: string, value: string) => Promise<boolean>;
  delete: (key: string) => Promise<boolean>;
  getAllKeys: () => Promise<string[]>;
  getKeyFor: (params: TKeyParams) => Promise<string | null>;
  fileExists: (path: string) => Promise<boolean>;
  fileUnlink: (path: string) => Promise<boolean>;
  fileSize: (path: string) => Promise<number>;
}

export function getCache<TKeyParams>(
  options: CacheOptions<TKeyParams>
): KeyValueCache<TKeyParams> {
  const cache = new Cache<TKeyParams>(
    options.prefix,
    options.evictionMillis,
    options.maxEntries,
    options.maxCacheSize,
    options.getValue,
    options.setValue,
    options.delete,
    options.getAllKeys,
    options.getKeyFor,
    options.fileExists,
    options.fileUnlink,
    options.fileSize
  );
  return wrapWithInit(cache, cache.ensureBooted.bind(cache));
}

export interface KeyValueCache<TKeyParams> {
  get: (params: TKeyParams) => Promise<string | null>;
  put: (params: TKeyParams, filePath: string) => Promise<boolean>;
  delete: (params: TKeyParams) => Promise<boolean>;
  cleanExpiredEntries: () => Promise<boolean>;
  getCurrentEntriesCount: () => Promise<number>;
  getCurrentDiskSize: () => Promise<number>;
  ensureBooted: () => Promise<void>;
}

/**
 * KeyValue Cache: This is the class that is used to store and retrieve values from the cache.
 * @param prefix - The prefix to use for the keys.
 * @param evictionMillis - The time in milliseconds after which an entry is considered expired.
 * @param maxEntries - The maximum number of entries to store in the cache.
 * @param maxCacheSize - The maximum size of the cache in bytes.
 *
 * @param getValue - Get the value for a given key.
 * @param setValue - Set the value for a given key.
 * @param delete - Delete the key/value for a given key.
 * @param getAllKeys - Get all the keys in the cache.
 * @param getKeyFor - Get the key for a given key parameters.
 *
 * @param fileExists - Check if a file exists.
 * @param fileUnlink - Unlink a file.
 * @param fileSize - Get the size of a file.
 *
 * @template TKeyParams - The type of the key parameters.
 */
class Cache<TKeyParams> implements KeyValueCache<TKeyParams> {
  private entriesCount: number = 0;
  private diskSize: number = 0;
  private bootPromise: Promise<void>;
  private isBooted: boolean = false;

  constructor(
    private readonly _prefix: string,
    private readonly _evictionMillis: number,
    private readonly _maxEntries: number,
    private readonly _maxCacheSize: number,
    private readonly _getValue: (key: string) => Promise<string | null>,
    private readonly _setValue: (
      key: string,
      value: string
    ) => Promise<boolean>,
    private readonly _delete: (key: string) => Promise<boolean>,
    private readonly _getAllKeys: () => Promise<string[]>,
    private readonly _getKeyFor: (params: TKeyParams) => Promise<string | null>,
    private readonly _fileExists: (path: string) => Promise<boolean>,
    private readonly _fileUnlink: (path: string) => Promise<boolean>,
    private readonly _fileSize: (path: string) => Promise<number>
  ) {
    this.bootPromise = this.boot();
  }

  async ensureBooted(): Promise<void> {
    if (!this.isBooted) {
      await this.bootPromise;
    }
  }

  private async boot() {
    const setCount = async () => {
      const count = await this.getOurKeysCount();
      this.entriesCount = count;
    };

    const setSize = async () => {
      const size = await this.getOurDiskSize();
      this.diskSize = size;
    };

    await Promise.all([setCount(), setSize()]);

    this.isBooted = true;
  }

  /**
   * Get the value for a given key params.
   *
   * @param params - The parameters to use to get the key.
   * @returns A promise that resolves to the value for the given key params or null if the value can't be retrieved.
   */
  async get(params: TKeyParams) {
    const key = await this._getKeyFor(params);

    if (!key) {
      return null;
    }

    const value = await this._getValue(key);

    if (!value) {
      return null;
    }

    let valueEntry: ValueEntry;
    try {
      valueEntry = parseValueEntry(value);
    } catch (err) {
      const isDeleted = await this._delete(key);
      if (isDeleted) {
        this.safeDecrementEntriesCount();
      }
      // We can't decrement the diskSize because the JSON is corrupted.

      return null;
    }

    const exists = await this._fileExists(valueEntry.filePath);

    if (!exists) {
      const isDeleted = await this._delete(key);
      if (isDeleted) {
        this.safeDecrementEntriesCount();
      }
      // We can't decrement the diskSize because the file does not exist.

      return null;
    }

    const evictionThreshold = Date.now() - this._evictionMillis;
    const cleaned = await this.cleanExpiredEntry(
      key,
      evictionThreshold,
      valueEntry
    );

    if (cleaned) {
      return null;
    }

    valueEntry.lastAccessed = Date.now();

    // No need to increment entriesCount or diskSize here, because we're just updating lastAccessed.
    await this._setValue(key, JSON.stringify(valueEntry));

    return valueEntry.filePath;
  }

  /**
   * Put a value for a given key params and file path.
   *
   * @param params - The parameters to use to get the key.
   * @param filePath - The file path to store the value.
   * @returns A promise that resolves to a boolean indicating if the value was put.
   */
  async put(params: TKeyParams, filePath: string) {
    const key = await this._getKeyFor(params);

    if (!key) {
      return false;
    }

    const newEntry: ValueEntry = {
      filePath,
      lastAccessed: Date.now(),
    };

    const isSet = await this._setValue(key, JSON.stringify(newEntry));

    if (!isSet) {
      return false;
    }

    this.entriesCount++;

    const exists = await this._fileExists(filePath);
    if (exists) {
      const fileSize = await this._fileSize(filePath);
      this.diskSize += fileSize;
    }

    if (this.entriesCount >= this._maxEntries) {
      await this.cleanUpCount();
    }

    if (this.diskSize >= this._maxCacheSize) {
      await this.cleanUpDiskSize();
    }

    return true;
  }

  /**
   * Delete a value for a given key params.
   *
   * @param params - The parameters to use to get the key.
   * @returns A promise that resolves to a boolean indicating if the value was deleted.
   */
  async delete(params: TKeyParams) {
    const key = await this._getKeyFor(params);

    if (!key) {
      return false;
    }

    const value = await this._getValue(key);

    if (!value) {
      return false;
    }

    const isDeleted = await this._delete(key);

    if (!isDeleted) {
      return false;
    }

    this.safeDecrementEntriesCount();

    try {
      const { filePath } = parseValueEntry(value);
      await this.tryDecrementDiskSize(filePath);
    } catch (err) {
      // Do nothing
      // We can't decrement the diskSize because the JSON is corrupted.
    }

    return true;
  }

  /**
   * Clean up expired entries.
   *
   * This method is used to clean up expired entries from the cache.
   *
   * @returns A promise that resolves to a boolean indicating if any entries were cleaned up.
   */
  async cleanExpiredEntries(): Promise<boolean> {
    const ourKeyValues = await this.getAllByOldestFirst();
    const evictionThreshold = Date.now() - this._evictionMillis;
    const promises: Promise<boolean>[] = [];

    for (const { key, valueEntry } of ourKeyValues) {
      promises.push(this.cleanExpiredEntry(key, evictionThreshold, valueEntry));
    }

    const cleaned = await Promise.all(promises);
    return cleaned.some(cleaned => cleaned);
  }

  private async cleanUpCount() {
    await this.ensureBooted(); //Needed in a private method, because it's not wrapped with wrapWithInit.
    const countToClean = this.entriesCount - this._maxEntries;

    if (countToClean <= 0) {
      return;
    }

    const ourKeyValues = await this.getAllByOldestFirst();
    const evictionThreshold = Date.now() - this._evictionMillis;

    for (const { key, valueEntry } of ourKeyValues) {
      if (this.entriesCount <= this._maxEntries) {
        break;
      }

      await this.cleanExpiredEntry(key, evictionThreshold, valueEntry);
    }
  }

  async getCurrentEntriesCount() {
    // We use Promise.resolve so the method is async, and wrapWithInit can wrap it.
    return await Promise.resolve(this.entriesCount);
  }

  async getCurrentDiskSize() {
    // We use Promise.resolve so the method is async, and wrapWithInit can wrap it.
    return await Promise.resolve(this.diskSize);
  }

  private async cleanUpDiskSize() {
    await this.ensureBooted(); //Needed in a private method, because it's not wrapped with wrapWithInit.

    const sizeToClean = this.diskSize - this._maxCacheSize;

    if (sizeToClean <= 0) {
      return;
    }

    const ourKeyValues = await this.getAllByOldestFirst();
    const evictionThreshold = Date.now() - this._evictionMillis;

    for (const { key, valueEntry } of ourKeyValues) {
      if (this.diskSize <= this._maxCacheSize) {
        break;
      }

      await this.cleanExpiredEntry(key, evictionThreshold, valueEntry);
    }
  }

  private async cleanExpiredEntry(
    key: string,
    evictionThreshold: number,
    valueEntry: ValueEntry
  ): Promise<boolean> {
    await this.ensureBooted(); //Needed in a private method, because it's not wrapped with wrapWithInit.

    if (valueEntry.lastAccessed < evictionThreshold) {
      const { filePath } = valueEntry;

      const isDeleted = await this._delete(key);

      if (!isDeleted) {
        return false;
      }

      this.safeDecrementEntriesCount();
      await this.tryDecrementDiskSize(filePath);
      return true;
    }

    return false;
  }

  private async getOurKeys() {
    const allKeys = await this._getAllKeys();
    return allKeys.filter(key => key.startsWith(this._prefix));
  }

  private async getOurKeysCount() {
    return (await this.getOurKeys()).length;
  }

  private async getOurDiskSize() {
    const ourKeys = await this.getOurKeys();
    let totalSize = 0;
    for (const key of ourKeys) {
      const value = await this._getValue(key);

      if (!value) {
        continue;
      }

      let valueEntry: ValueEntry;
      try {
        valueEntry = parseValueEntry(value);
      } catch (err) {
        const isDeleted = await this._delete(key);
        if (isDeleted) {
          this.safeDecrementEntriesCount();
        }
        // We can't decrement the diskSize because the JSON is corrupted.
        continue;
      }

      const exists = await this._fileExists(valueEntry.filePath);
      if (exists) {
        totalSize += await this._fileSize(valueEntry.filePath);
      } else {
        const isDeleted = await this._delete(key);
        if (isDeleted) {
          this.safeDecrementEntriesCount();
        }
        // We can't decrement the diskSize because the file does not exist.
      }
    }
    return totalSize;
  }

  private async getAllByOldestFirst(): Promise<
    { key: string; valueEntry: ValueEntry }[]
  > {
    const ourKeys = await this.getOurKeys();

    const allKeyValues = await Promise.all(
      ourKeys.map(async key => {
        const value = await this._getValue(key);
        if (!value) {
          return null;
        }
        try {
          const valueEntry = parseValueEntry(value);
          return { key, valueEntry };
        } catch (err) {
          const isDeleted = await this._delete(key);
          if (isDeleted) {
            this.safeDecrementEntriesCount();
          }
          // We can't decrement the diskSize because the JSON is corrupted.
          return null;
        }
      })
    );

    const sortedAndFiltered = allKeyValues
      .filter(
        (item): item is { key: string; valueEntry: ValueEntry } => item !== null
      )
      .sort((a, b) => a.valueEntry.lastAccessed - b.valueEntry.lastAccessed);

    return sortedAndFiltered;
  }

  private safeDecrementEntriesCount() {
    // Preventing failures and bugs to decrement below 0.
    if (this.entriesCount > 0) {
      this.entriesCount--;
    }
  }

  private safeDecrementDiskSize(size: number) {
    // Preventing failures and bugs to decrement below 0.
    if (this.diskSize >= size) {
      this.diskSize -= size;
    }
  }

  private async tryDecrementDiskSize(filePath: string) {
    const exists = await this._fileExists(filePath);
    if (exists) {
      const fileSize = await this._fileSize(filePath);
      const isUnlinked = await this._fileUnlink(filePath);
      if (isUnlinked) {
        this.safeDecrementDiskSize(fileSize);
      }
    }
  }
}

// Ensures every method is wrapped with ensureBooted.
function wrapWithInit<T extends object>(
  target: T,
  ensureInitialized: () => Promise<void>
): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const val = Reflect.get(obj, prop, receiver);
      if (typeof val === "function" && !prop.toString().startsWith("_")) {
        return async function (...args: any[]) {
          await ensureInitialized.call(obj);
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return
          return val.apply(obj, args);
        };
      }
      return val;
    },
  });
}

// Validates and parses the value entry.
export function parseValueEntry(json: string): ValueEntry {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("Invalid JSON");
  }
  assertValueEntry(data);
  return data;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

function assertValueEntry(v: unknown): asserts v is ValueEntry {
  if (!isPlainObject(v)) {
    throw new Error("Expected an object");
  }

  const { filePath, lastAccessed } = v;

  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error("filePath must be a non-empty string");
  }

  if (
    typeof lastAccessed !== "number" ||
    !Number.isFinite(lastAccessed) ||
    !Number.isInteger(lastAccessed) ||
    lastAccessed <= 0
  ) {
    throw new Error("lastAccessed must be a positive integer");
  }
}
