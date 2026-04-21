declare module "lodash" {
  export function get<TObject extends object, TDefault = undefined>(
    object: TObject | null | undefined,
    path: string | Array<string | number>,
    defaultValue?: TDefault,
  ): any;
  export function cloneDeep<T>(value: T): T;
  export function isArray(value: unknown): value is unknown[];
  export function compact<T>(array: Array<T | null | undefined | false | 0 | "">): T[];
  export function noop(...args: unknown[]): void;
  export function isEmpty(value: unknown): boolean;
}
