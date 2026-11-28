
import stringify from "fast-json-stable-stringify";

/** typesafe by-value object map keys */
export type Key<T> = string & { readonly __brand: "key", readonly __phantomData: T };

/** REQUIRES: the value passed in is safe to stringify */
export function toKey<T>(x: T): Key<T> {
    return stringify(x) as Key<T>;
}

export function fromKey<T>(key: Key<T>): T {
    return JSON.parse(key);
}

export type Route = {
    rt: string
}
