import z from "zod";

const zodValueEntry = z.object({
  filePath: z.string(),
  lastAccessed: z.number().int().positive(),
});

type ValueEntry = z.infer<typeof zodValueEntry>;

/**
 * KeyValue Cache Adapter
 *
 * This is the interface that the KeyValueCache class uses to interact with the underlying storage.
 *
 * @field prefix - The prefix to use for the keys.
 * @field evictionMillis - The time in milliseconds after which an entry is considered expired.
 * @field maxEntries - The maximum number of entries to store in the cache.
 * @field maxCacheSize - The maximum size of the cache in bytes.
 *
 * @field getValueForKey - Get the value for a given key.
 * @field setValueForKey - Set the value for a given key.
 * @field deleteKeyValue - Delete the value for a given key.
 * @field getAllKeys - Get all the keys in the cache.
 * @field getKeyFor - Get the key for a given key parameters.
 *
 * @field fileExists - Check if a file exists.
 * @field fileUnlink - Unlink a file.
 * @field fileSize - Get the size of a file.
 *
 * @template TKeyParams - The type of the key parameters.
 */
export interface KeyValueCacheAdapter<TKeyParams> {
  // Props
  prefix: string;
  evictionMillis: number;
  maxEntries: number;
  maxCacheSize: number;

  // KeyValue Adapter
  getValueForKey(key: string): Promise<string | null>;
  setValueForKey(key: string, value: string): Promise<void>;
  deleteKeyValue(key: string): Promise<void>;
  getAllKeys(): Promise<string[]>;
  getKeyFor(params: TKeyParams): Promise<string | null>;

  // File System Adapter
  fileExists(path: string): Promise<boolean>;
  fileUnlink(path: string): Promise<void>;
  fileSize(path: string): Promise<number>;
}

/**
 * KeyValue Cache
 *
 * This is the class that is used to store and retrieve values from the cache.
 *
 * @template TKeyParams - The type of the key parameters.
 */
export class KeyValueCache<TKeyParams> {
  private entriesCount: number = 0;
  private diskSize: number = 0;
  private bootPromise: Promise<void>;
  private isBooted: boolean = false;

  constructor(private adapter: KeyValueCacheAdapter<TKeyParams>) {
    this.bootPromise = Promise.all([
      this.getOurKeysCount().then(count => {
        this.entriesCount = count;
      }),
      this.getOurDiskSize().then(size => {
        this.diskSize = size;
      }),
    ]).then(() => {
      this.isBooted = true;
    });
  }

  /**
   * Get the value for a given key params.
   *
   * @param params - The parameters to use to get the key.
   * @returns A promise that resolves to the value for the given key params or null if the value can't be retrieved.
   */
  async get(params: TKeyParams) {
    if (!this.isBooted) {
      await this.bootPromise;
    }

    const key = await this.adapter.getKeyFor(params);

    if (!key) {
      return null;
    }

    const value = await this.adapter.getValueForKey(key);

    if (!value) {
      return null;
    }

    let valueEntry: ValueEntry;
    try {
      valueEntry = zodValueEntry.parse(JSON.parse(value));
    } catch (err) {
      await this.adapter.deleteKeyValue(key);
      return null;
    }

    const exists = await this.adapter.fileExists(valueEntry.filePath);

    if (!exists) {
      await this.adapter.deleteKeyValue(key);
      return null;
    }

    const evictionThreshold = Date.now() - this.adapter.evictionMillis;
    const cleaned = await this.cleanExpiredEntry(
      key,
      evictionThreshold,
      valueEntry
    );

    if (cleaned) {
      return null;
    }

    valueEntry.lastAccessed = Date.now();

    await this.adapter.setValueForKey(key, JSON.stringify(valueEntry));

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
    if (!this.isBooted) {
      await this.bootPromise;
    }

    const key = await this.adapter.getKeyFor(params);

    if (!key) {
      return false;
    }

    const newEntry: ValueEntry = {
      filePath,
      lastAccessed: Date.now(),
    };

    await this.adapter.setValueForKey(key, JSON.stringify(newEntry));
    this.entriesCount++;

    const exists = await this.adapter.fileExists(filePath);
    if (exists) {
      const fileSize = await this.adapter.fileSize(filePath);
      this.diskSize += fileSize;
    }

    if (this.entriesCount >= this.adapter.maxEntries) {
      await this.cleanUpCount();
    }

    if (this.diskSize >= this.adapter.maxCacheSize) {
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
    if (!this.isBooted) {
      await this.bootPromise;
    }

    const key = await this.adapter.getKeyFor(params);

    if (!key) {
      return false;
    }

    const value = await this.adapter.getValueForKey(key);

    if (!value) {
      return false;
    }

    await this.adapter.deleteKeyValue(key);
    this.entriesCount--;

    if (!value) {
      return true;
    }

    try {
      const { filePath } = zodValueEntry.parse(JSON.parse(value));
      const exists = await this.adapter.fileExists(filePath);
      if (exists) {
        const fileSize = await this.adapter.fileSize(filePath);
        this.diskSize -= fileSize;
        await this.adapter.fileUnlink(filePath);
      }
    } catch (err) {
      // Do nothing
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
    if (!this.isBooted) {
      await this.bootPromise;
    }

    const ourKeyValues = await this.getAllByOldestFirst();
    const evictionThreshold = Date.now() - this.adapter.evictionMillis;
    const promises: Promise<boolean>[] = [];

    for (const { key, valueEntry } of ourKeyValues) {
      promises.push(this.cleanExpiredEntry(key, evictionThreshold, valueEntry));
    }

    const cleaned = await Promise.all(promises);
    return cleaned.some(cleaned => cleaned);
  }

  private async cleanUpCount() {
    if (!this.isBooted) {
      await this.bootPromise;
    }

    const countToClean = this.entriesCount - this.adapter.maxEntries;

    if (countToClean <= 0) {
      return;
    }

    const ourKeyValues = await this.getAllByOldestFirst();
    const evictionThreshold = Date.now() - this.adapter.evictionMillis;

    for (const { key, valueEntry } of ourKeyValues) {
      if (this.entriesCount <= this.adapter.maxEntries) {
        break;
      }

      await this.cleanExpiredEntry(key, evictionThreshold, valueEntry);
    }
  }

  async getCurrentEntriesCount() {
    if (!this.isBooted) {
      await this.bootPromise;
    }

    return this.entriesCount;
  }

  async getCurrentDiskSize() {
    if (!this.isBooted) {
      await this.bootPromise;
    }

    return this.diskSize;
  }

  private async cleanUpDiskSize() {
    if (!this.isBooted) {
      await this.bootPromise;
    }

    const sizeToClean = this.diskSize - this.adapter.maxCacheSize;

    if (sizeToClean <= 0) {
      return;
    }

    const ourKeyValues = await this.getAllByOldestFirst();
    const evictionThreshold = Date.now() - this.adapter.evictionMillis;

    for (const { key, valueEntry } of ourKeyValues) {
      if (this.diskSize <= this.adapter.maxCacheSize) {
        break;
      }

      await this.cleanExpiredEntry(key, evictionThreshold, valueEntry);
    }
  }

  private async cleanExpiredEntry(
    key: string,
    evictionThreshold: number,
    valueEntry?: ValueEntry
  ): Promise<boolean> {
    let internalValue: ValueEntry;

    if (valueEntry) {
      internalValue = valueEntry;
    } else {
      const value = await this.adapter.getValueForKey(key);

      if (!value) {
        return false;
      }

      try {
        internalValue = zodValueEntry.parse(JSON.parse(value));
      } catch (err) {
        await this.adapter.deleteKeyValue(key);
        return false;
      }
    }

    if (internalValue.lastAccessed < evictionThreshold) {
      const { filePath } = internalValue;

      await this.adapter.deleteKeyValue(key);
      this.entriesCount--;

      const exists = await this.adapter.fileExists(filePath);
      if (exists) {
        const fileSize = await this.adapter.fileSize(filePath);
        return this.adapter.fileUnlink(filePath).then(() => {
          this.diskSize -= fileSize;
          return true;
        });
      }

      return true;
    }

    return false;
  }

  private async getOurKeys() {
    const allKeys = await this.adapter.getAllKeys();
    return allKeys.filter(key => key.startsWith(this.adapter.prefix));
  }

  private async getOurKeysCount() {
    return (await this.getOurKeys()).length;
  }

  private async getOurDiskSize() {
    const ourKeys = await this.getOurKeys();
    let totalSize = 0;
    for (const key of ourKeys) {
      const value = await this.adapter.getValueForKey(key);

      if (!value) {
        continue;
      }

      let valueEntry: ValueEntry;
      try {
        valueEntry = zodValueEntry.parse(JSON.parse(value));
      } catch (err) {
        await this.adapter.deleteKeyValue(key);
        continue;
      }

      const exists = await this.adapter.fileExists(valueEntry.filePath);
      if (exists) {
        totalSize += await this.adapter.fileSize(valueEntry.filePath);
      } else {
        await this.adapter.deleteKeyValue(key);
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
        const value = await this.adapter.getValueForKey(key);
        if (!value) {
          return null;
        }
        try {
          const valueEntry = zodValueEntry.parse(JSON.parse(value));
          return { key, valueEntry };
        } catch (err) {
          await this.adapter.deleteKeyValue(key);
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
}
