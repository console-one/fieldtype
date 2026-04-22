import { NodeAdapter, djb2 } from "@console-one/wire";
import { ConstraintTypes } from "./constraint.js";
import { FieldType } from "./type.js";
import { FieldTypeEvent } from "./event.js";

/** Event serialization mode for FieldType */
export type FTEventMode = "chain" | "snapshot";

/** Helpers shared by all FieldType adapters */
const isFT = FieldType.describes;

export const ftDeps = (ft: FieldType): any[] => {
  switch (ft.fieldtype) {
    case "object": {
      const list: any[] = [];
      (ft.attributes ?? [])
        .filter(ConstraintTypes.object.property.describes)
        .forEach((p: any) => list.push(p.value as FieldType));
      (ft.attributes ?? [])
        .filter((a: any) => ConstraintTypes.object.index?.describes?.(a))
        .forEach((ix: any) => {
          list.push(ix.value as FieldType);
          if (ix.when) list.push(ix.when as FieldType);
        });
      const addl = (ft.attributes ?? []).find(
        ConstraintTypes.object.additional?.describes as any,
      ) as any;
      if (addl && addl.value && addl.value !== false)
        list.push(addl.value as FieldType);
      return list;
    }
    case "array": {
      const v = (ft.attributes ?? []).find(
        (a: any) =>
          ConstraintTypes.array.describes(a) && a.constrainttype === "values",
      ) as any;
      const c = (ft.attributes ?? []).find(
        ConstraintTypes.array.contains?.describes as any,
      ) as any;
      const out: any[] = [];
      if (v?.value) out.push(v.value as FieldType);
      if (c?.value) out.push(c.value as FieldType);
      return out;
    }
    case "or":
    case "and":
    case "not":
      return (ft.attributes as any[]).filter(FieldType.describes) as FieldType[];
    default:
      return [];
  }
};

const encodeFTAttr = (
  a: any,
  ref: (child: any) => { $ref: string },
): any => {
  if (FieldType.describes(a)) return ref(a);

  // object.property
  if (
    ConstraintTypes.object.property.describes(a) &&
    FieldType.describes(a.value)
  ) {
    return { ...a, value: ref(a.value) };
  }
  // array.values / accumulate
  if (
    ConstraintTypes.array.values.describes?.(a) &&
    FieldType.describes(a.value)
  ) {
    return { ...a, value: ref(a.value) };
  }
  if (
    ConstraintTypes.array.accumulate?.describes?.(a) &&
    FieldType.describes(a.value)
  ) {
    return { ...a, value: ref(a.value) };
  }
  // object.index
  if (
    ConstraintTypes.object.index?.describes?.(a) &&
    FieldType.describes(a.value)
  ) {
    const out: any = { ...a, value: ref(a.value) };
    // Normalize key: RegExp -> string; leave strings as-is
    if (a.key && typeof a.key !== "string") out.key = String(a.key);
    if (a.when && FieldType.describes(a.when)) out.when = ref(a.when);
    return out;
  }
  return a;
};

const decodeFTAttr = (a: any, get: (key: string) => any): any => {
  const isRef = (x: any): x is { $ref: string } =>
    x && typeof x === "object" && typeof x.$ref === "string";
  if (isRef(a)) return get(a.$ref);

  if (
    ConstraintTypes.object.property.describes(a) &&
    a.value &&
    a.value.$ref
  ) {
    return { ...a, value: get(a.value.$ref) };
  }
  if (ConstraintTypes.array.values.describes?.(a) && a.value && a.value.$ref) {
    return { ...a, value: get(a.value.$ref) };
  }
  if (
    ConstraintTypes.array.accumulate?.describes?.(a) &&
    a.value &&
    a.value.$ref
  ) {
    return { ...a, value: get(a.value.$ref) };
  }
  if (ConstraintTypes.object.index?.describes?.(a)) {
    const out: any = { ...a };
    if (a.value && a.value.$ref) out.value = get(a.value.$ref);
    if (a.when && a.when.$ref) out.when = get(a.when.$ref);
    // a.key is left as-is (string form) which round-trips deterministically
    return out;
  }
  return a;
};

function encodeEvent(ev: any, ref: (child: any) => { $ref: string }) {
  if (ev.eventtype === "state") {
    const attrs = (ev.attributes ?? []).map((a: any) => encodeFTAttr(a, ref));
    const exts  = (ev.extensions ?? []).map((x: any) =>
      FieldType.describes(x) ? ref(x) : x
    );
    return {
      type: "fieldtypeevent",
      eventtype: "state",
      id: ev.id,
      fieldtype: ev.fieldtype,
      attributes: attrs,
      metadata: ev.metadata,
      extensions: exts,
    };
  } else {
    const rawAttrs = ev.attributes;
    const attrsEncoded = Array.isArray(rawAttrs)
      ? rawAttrs.map((a: any) => encodeFTAttr(a, ref))
      : rawAttrs === undefined
        ? undefined
        : encodeFTAttr(rawAttrs, ref);

    const extension =
      ev.extension && FieldType.describes(ev.extension)
        ? ref(ev.extension)
        : ev.extension;

    const targetId = typeof ev.target === "string" ? ev.target : ev.target?.id;

    // Include the 'update' alias for FieldType.fromEvent compatibility
    const out: any = {
      type: "fieldtypeevent",
      eventtype: "patch",
      id: ev.id,
      target: targetId,
      update: targetId,
      ...(attrsEncoded !== undefined ? { attributes: attrsEncoded } : {}),
      ...(ev.metadata !== undefined ? { metadata: ev.metadata } : {}),
      ...(extension ? { extension } : {}),
    };
    return out;
  }
}

function decodeEvent(data: any, get: (key: string) => any) {
  if (data.eventtype === "state") {
    const attrs = (data.attributes ?? []).map((a: any) => decodeFTAttr(a, get));
    const exts  = (data.extensions ?? []).map((x: any) =>
      x && x.$ref ? get(x.$ref) : x
    );
    return FieldTypeEvent.state.create({
      fieldtype: data.fieldtype,
      attributes: attrs,
      metadata: data.metadata,
      extensions: exts,
      id: data.id,
    });
  } else {
    const rawAttrs = data.attributes;
    const attrsDecoded = Array.isArray(rawAttrs)
      ? rawAttrs.map((a: any) => decodeFTAttr(a, get))
      : rawAttrs === undefined
        ? undefined
        : decodeFTAttr(rawAttrs, get);

    const ext =
      data.extension && data.extension.$ref
        ? get(data.extension.$ref)
        : data.extension;

    return FieldTypeEvent.patch.create({
      target: data.target, // string id
      attributes: attrsDecoded as any,
      metadata: data.metadata,
      extension: ext as any,
      id: data.id,
    });
  }
}

/**
 * Build a FieldType adapter with the desired event serialization mode.
 * - "chain" (default): creation + patch events
 * - "snapshot": single creation event for the current state
 */
export function makeFTAdapter(eventMode: FTEventMode = "chain"): NodeAdapter<FieldType> {
  return {
    type: "fieldtype",
    matches: isFT,
    key(ft) {
      return "ft:" + djb2(JSON.stringify(ft));
    },
    deps: ftDeps,
    toJSON(node, ref) {
      if (eventMode === "snapshot") {
        // Synthetic creation event representing *current* state.
        const synthetic = {
          type: "fieldtypeevent",
          eventtype: "state" as const,
          id: crypto.randomUUID(),
          fieldtype: node.fieldtype,
          attributes: (node.attributes ?? []) as any[],
          metadata: (node as any).metadata ?? {},
          extensions: (node.extensions ?? []) as any[],
        };
        return { events: [encodeEvent(synthetic, ref)] };
      }

      // eventMode === "chain"
      const events = (node as any).toEvents?.({ withDraft: true }) ?? [];
      const eventsJson = events.map((e: any) => encodeEvent(e, ref));
      return { events: eventsJson };
    },
    fromJSON(data, get) {
      // Preferred path: event-based
      if (Array.isArray((data as any).events) && (data as any).events.length) {
        const evs = (data as any).events.map((e: any) => decodeEvent(e, get));
        const ctx: Record<string, any> = {};
        for (const e of evs) ctx[(e as any).id] = e;
        const last = evs[evs.length - 1];
        return FieldType.fromEvent(last, ctx) as FieldType;
      }

      // Legacy fallback: plain snapshot structure { fieldtype, attributes, metadata }
      const attrs = (data.attributes ?? []).map((a: any) =>
        decodeFTAttr(a, get),
      );
      const out: any = {
        fieldtype: data.fieldtype,
        attributes: attrs,
      };
      if (data.metadata !== undefined) out.metadata = data.metadata;
      return out as FieldType;
    },
  };
}

/** Default adapters (for convenience) */
export const FTAdapter = makeFTAdapter("chain");      // full history (audit/replay)
export const FTAdapterSnapshot = makeFTAdapter("snapshot"); // single creation event for current state

// If you expose a registry helper, keep both:
export const WireAdapters = {
  fieldtype: FTAdapter,
  fieldtypeSnapshot: FTAdapterSnapshot,
};
