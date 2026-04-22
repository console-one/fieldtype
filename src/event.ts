
import { BaseFieldTypeProps, FieldType } from "./type.js";
import { FieldTypeError } from './error.js';
import { compactTree } from '@console-one/wire';

import type { ObjWithout } from "./type.js";


export type BaseFieldTypeEvent<
  Name extends string = string,
  Props extends ObjWithout<"type" | "eventtype"> = ObjWithout<
    "type" | "eventtype"
  >,
> = {
  type: "fieldtypeevent";
  eventtype: Name;
} & Props;

export type FieldTypeCreationEvent<
  T extends string = string,
  Attributes = any,
> = BaseFieldTypeEvent<
  "state",
  {
    id?: string;
    fieldtype: T;
    attributes: Attributes[];
    metadata?: any;
    extensions?: any[];
    scope?: string;
  }
>;

export type FieldTypePatchEvent<
  Attributes = any,
  ExtensionType extends string = string,
  Specific extends BaseFieldTypeProps<
    ExtensionType,
    any
  > = BaseFieldTypeProps<ExtensionType>,
> = BaseFieldTypeEvent<
  "patch",
  {
    id?: string;
    target: string | BaseFieldTypeEvent;
    attributes?: Attributes;
    metadata?: any;
    extension?: Specific;
    scope?: string;
  }
>;



export type FieldTypeEvent = FieldTypePatchEvent | FieldTypeCreationEvent;

export const FieldTypeEvent = {
  /* ----------  top‑level helpers  ---------- */

  /**
   * Generic factory that delegates to the specific helpers below.
   */
  create: <
    FT extends string = string,
    Attr = any,
    Ext extends string = string,
    Specific extends BaseFieldTypeProps<Ext, any> = BaseFieldTypeProps<Ext>,
  >(
    cfg:
      | ({ eventtype: "state" } & {
          fieldtype: FT;
          attributes?: Attr[];
          metadata?: any;
          extensions?: any[];
          id?: string;
        })
      | ({ eventtype: "patch" } & {
          target: string | BaseFieldTypeEvent;
          attributes?: Attr;
          metadata?: any;
          extension?: Specific;
          id?: string;
        }),
  ): FieldTypeEvent =>
    cfg.eventtype === "state"
      ? (FieldTypeEvent.state.create(cfg) as FieldTypeEvent)
      : (FieldTypeEvent.patch.create(cfg) as unknown as FieldTypeEvent),

  /** Type‑guard for *any* `FieldTypeEvent` */
  describes(item: unknown): item is FieldTypeEvent {
    return (
      !!item &&
      typeof item === "object" &&
      (item as any).type === "fieldtypeevent" &&
      ((item as any).eventtype === "state" ||
        (item as any).eventtype === "patch")
    );
  },

  /* ----------  state  (creation)  ---------- */

  state: {
    /**
     * Build a `FieldTypeCreationEvent`.
     */
    create<FT extends string = string, Attr = any>(cfg: {
      fieldtype: FT;
      attributes?: Attr[];
      extensions?: any[];
      metadata?: any;
      id?: string;
    }): FieldTypeCreationEvent<FT, Attr> {
      const ev: any = {
        type: "fieldtypeevent",
        eventtype: "state",
        id: cfg.id ?? crypto.randomUUID(),
        fieldtype: cfg.fieldtype,
        attributes: cfg.attributes ?? [],
        metadata: cfg.metadata,
        extensions: cfg.extensions ?? [],
      };
      Object.defineProperty(ev, 'toJSON', { enumerable: false, value: () => compactTree(ev) });
      return ev;
    },

    /** Type‑guard for `FieldTypeCreationEvent` */
    describes(item: unknown): item is FieldTypeCreationEvent {
      return (
        FieldTypeEvent.describes(item) &&
        (item as FieldTypeEvent).eventtype === "state"
      );
    },
  },

  /* ----------  patch  ---------- */

  patch: {
    /**
     * Build a `FieldTypePatchEvent`.
     */
    create<
      Attr = any,
      Ext extends string = string,
      Specific extends BaseFieldTypeProps<Ext, any> = BaseFieldTypeProps<Ext>,
    >(cfg: {
      target: string | BaseFieldTypeEvent;
      attributes?: Attr;
      metadata?: any;
      extension?: Specific;
      id?: string;
    }): FieldTypePatchEvent<Attr, Ext, Specific> {
      /* NB:  we include BOTH `target` (required by the type) and
           a duplicate alias `update` so existing runtime helpers that
           still expect `update` continue to work. */
      const ev: any = {
        type: "fieldtypeevent",
        eventtype: "patch",
        id: cfg.id ?? crypto.randomUUID(),
        target: cfg.target,
        attributes: cfg.attributes,
        metadata: cfg.metadata,
        extension: cfg.extension,
      };
      ev.update = cfg.target; // runtime shim
      Object.defineProperty(ev, 'toJSON', { enumerable: false, value: () => compactTree(ev) });
      return ev as FieldTypePatchEvent<Attr, Ext, Specific>;
    },

    /** Type‑guard for `FieldTypePatchEvent` */
    describes(item: unknown): item is FieldTypePatchEvent {
      return (
        FieldTypeEvent.describes(item) &&
        (item as FieldTypeEvent).eventtype === "patch"
      );
    },
  },
};


import { ConstraintTypes } from "./constraint.js";

// 1) Add/strengthen properties on `base` (intersection semantics).
export function patchProps<T extends FieldType>(
  base: T,
  shape: Record<string, FieldType>,
  opts: Record<string, { optional?: boolean; default?: unknown; reason?: string }> = {}
): T {
  const attrs = Object.entries(shape).map(([k, v]) =>
    ConstraintTypes.object.property.create(k, v.save(), opts[k] ?? {})
  );
  const ev = FieldTypeEvent.patch.create({
    target: base.toEvent(),
    attributes: attrs as any
  });
  return FieldType.extend(base, ev as any) as T;
}

// 2) Replace selected props (drop old constraints for those keys, keep others).
export function replaceProps<T extends FieldType>(
  base: T,
  shape: Record<string, FieldType>,
  opts: Record<string, { optional?: boolean; default?: unknown; reason?: string }> = {}
): T {
  const kept = (base.attributes ?? []).filter(a =>
    !(ConstraintTypes.object.property.describes(a) && (a.key in shape))
  );
  const add  = Object.entries(shape).map(([k, v]) =>
    ConstraintTypes.object.property.create(k, v.save(), opts[k] ?? {})
  );
  return FieldType.create("object", [...kept, ...add]) as unknown as T;
}

// 3) Compose all constraints along a path to get the effective leaf type.
//    (Best-effort; objects only. Extend as needed.)
export function typeAtPathComposed(root: FieldType, path: string): FieldType {
  const parts = path.split(".").filter(Boolean);
  let cur: FieldType = root;
  for (const seg of parts) {
    if (cur.fieldtype !== "object") {
      throw new FieldTypeError('TYPE_MISMATCH', `typeAtPathComposed: non-object segment at "${seg}"`, undefined, { segment: seg, fieldtype: cur.fieldtype });
    }
    const props = (cur.attributes ?? [])
      .filter(ConstraintTypes.object.property.describes) as any[];
    const matches = props.filter(p => p.key === seg).map(p => p.value as FieldType);
    if (matches.length === 0) throw new FieldTypeError('TYPE_MISMATCH', `typeAtPathComposed: missing property "${seg}"`, undefined, { property: seg, available: props.map(p => p.key) });
    cur = matches.slice(1).reduce((acc, v) => FieldType.compose(acc, v), matches[0]);
  }
  return cur;
}
