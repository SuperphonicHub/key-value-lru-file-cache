# key-value-lru-file-cache

[![npm package][npm-img]][npm-url]
[![Build Status][build-img]][build-url]
[![Downloads][downloads-img]][downloads-url]
[![Issues][issues-img]][issues-url]
[![Code Coverage][codecov-img]][codecov-url]
[![Commitizen Friendly][commitizen-img]][commitizen-url]
[![Semantic Release][semantic-release-img]][semantic-release-url]

## Install

```bash
npm install key-value-lru-file-cache
```

or

```bash
yarn add key-value-lru-file-cache
```

## Example

```TS
import { KeyValueCache } from "key-value-lru-file-cache";
import MMKV from "react-native-mmkv";
import ReactNativeBlobUtil from "react-native-blob-util";

// Example key parameters type
interface ImageCacheKey {
  remoteImgPath: string;
  width: number;
  height: number;
}

// Create the cache instance
const imageCache = new KeyValueCache<ImageCacheKey>({
  prefix: "IMG_RESIZED",
  evictionMillis: 7 * 24 * 60 * 60 * 1000, // 1 week
  maxEntries: 1000,
  maxCacheSize: 300 * 1024 * 1024, // 300MB

  // Key/value storage using MMKV
  getValueForKey: async key => MMKV.getString(key) ?? null,
  setValueForKey: async (key, value) => {
    try {
      MMKV.set(key, value);
      return true;
    } catch {
      return false;
    }
  },
  deleteKeyValue: async key => {
    try {
      MMKV.delete(key);
      return true;
    } catch {
      return false;
    }
  },
  getAllKeys: async () => MMKV.getAllKeys(),
  getKeyFor: async params => {
    const encodedUri = encodeURIComponent(params.remoteImgPath);
    return `IMG_RESIZED:${encodedUri}-${params.width}-${params.height}`;
  },

  // File system operations using react-native-blob-util
  fileExists: path => ReactNativeBlobUtil.fs.exists(path),
  fileUnlink: async path => {
    try {
      await ReactNativeBlobUtil.fs.unlink(path);
      return true;
    } catch {
      return false;
    }
  },
  fileSize: async path => {
    const stat = await ReactNativeBlobUtil.fs.stat(path);
    return stat.size;
  },
});

// Using the cache
async function exampleUsage() {
  // Put a file in cache
  await imageCache.put(
    {
      remoteImgPath: "https://example.com/image.jpg",
      width: 200,
      height: 200,
    },
    "/local/path/to/resized-image.jpg"
  );

  // Get a file from cache
  const filePath = await imageCache.get({
    remoteImgPath: "https://example.com/image.jpg",
    width: 200,
    height: 200,
  });

  if (filePath) {
    console.log("Found cached file:", filePath);
  } else {
    console.log("File not in cache or expired");
  }

  // Clean expired entries
  await imageCache.cleanExpiredEntries();
}
```

## API

### `KeyValueCache<TKeyParams>`

A generic, adapter‑based key‑value + file LRU cache with eviction based on:

- **Max age** (`evictionMillis`)
- **Max entries** (`maxEntries`)
- **Max total disk size** (`maxCacheSize`)

### Constructor

```TS
new KeyValueCache<TKeyParams>(adapter: KeyValueCacheAdapter<TKeyParams>)
```

**Parameters:**

| Parameter | Type                               | Description                                                                            |
| --------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| `adapter` | `KeyValueCacheAdapter<TKeyParams>` | Implementation of the key‑value and file system adapter methods required by the cache. |

### Adapter Interface: `KeyValueCacheAdapter<TKeyParams>`

| Property / Method            | Type                                               | Description                                        |
| ---------------------------- | -------------------------------------------------- | -------------------------------------------------- |
| `prefix`                     | `string`                                           | Prefix for all keys in the cache.                  |
| `evictionMillis`             | `number`                                           | Max age (in milliseconds) before an entry expires. |
| `maxEntries`                 | `number`                                           | Maximum number of entries allowed in the cache.    |
| `maxCacheSize`               | `number`                                           | Maximum total cache size in bytes.                 |
| `getValueForKey(key)`        | `(key: string) => Promise<string \| null>`         | Get value for a given key.                         |
| `setValueForKey(key, value)` | `(key: string, value: string) => Promise<boolean>` | Store value for a given key.                       |
| `deleteKeyValue(key)`        | `(key: string) => Promise<boolean>`                | Delete a key/value pair.                           |
| `getAllKeys()`               | `() => Promise<string[]>`                          | Get all keys from the store.                       |
| `getKeyFor(params)`          | `(params: TKeyParams) => Promise<string \| null>`  | Build a unique key string from parameters.         |
| `fileExists(path)`           | `(path: string) => Promise<boolean>`               | Check if a file exists at the given path.          |
| `fileUnlink(path)`           | `(path: string) => Promise<boolean>`               | Delete a file at the given path.                   |
| `fileSize(path)`             | `(path: string) => Promise<number>`                | Get file size in bytes.                            |

### Instance Methods

| Method                     | Returns                   | Description                                                                                 |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------------------------- |
| `get(params)`              | `Promise<string \| null>` | Get file path for given params if entry exists and is valid. Updates `lastAccessed` on hit. |
| `put(params, filePath)`    | `Promise<boolean>`        | Add/update an entry in the cache. Triggers eviction if limits exceeded.                     |
| `delete(params)`           | `Promise<boolean>`        | Remove an entry and delete its file if present.                                             |
| `cleanExpiredEntries()`    | `Promise<boolean>`        | Remove all entries older than `evictionMillis`. Returns `true` if any were removed.         |
| `getCurrentEntriesCount()` | `Promise<number>`         | Get current number of cached entries.                                                       |
| `getCurrentDiskSize()`     | `Promise<number>`         | Get current total cache size in bytes.                                                      |

[build-img]: https://github.com/SuperphonicHub/key-value-lru-file-cache/actions/workflows/release.yml/badge.svg
[build-url]: https://github.com/SuperphonicHub/key-value-lru-file-cache/actions/workflows/release.yml
[downloads-img]: https://img.shields.io/npm/dt/key-value-lru-file-cache
[downloads-url]: https://www.npmtrends.com/key-value-lru-file-cache
[npm-img]: https://img.shields.io/npm/v/key-value-lru-file-cache
[npm-url]: https://www.npmjs.com/package/key-value-lru-file-cache
[issues-img]: https://img.shields.io/github/issues/SuperphonicHub/key-value-lru-file-cache
[issues-url]: https://github.com/SuperphonicHub/key-value-lru-file-cache/issues
[codecov-img]: https://codecov.io/gh/SuperphonicHub/key-value-lru-file-cache/branch/main/graph/badge.svg
[codecov-url]: https://codecov.io/gh/SuperphonicHub/key-value-lru-file-cache
[semantic-release-img]: https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg
[semantic-release-url]: https://github.com/semantic-release/semantic-release
[commitizen-img]: https://img.shields.io/badge/commitizen-friendly-brightgreen.svg
[commitizen-url]: http://commitizen.github.io/cz-cli/
