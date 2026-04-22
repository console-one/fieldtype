import * as find from "./find.js";
import { ConstraintTypes } from "./constraint.js";
import { FieldType, literalFromAttributes } from "./type.js";



export type CallableType<CallableClass extends any=any, CallableCall extends ((...args: any[]) => any)= ((...args: any[]) => any)> = CallableClass & { call: CallableCall } & CallableCall

export class Callable<CallableClass extends any=any, CallableCall extends ((...args: any[]) => any)= ((...args: any[]) => any)> {

    public call: CallableCall

    constructor(call: CallableCall) {
        const impl: any = (...args) => {
            return call.apply(this, args);
        }
        this.call = impl;
        impl.call = impl; 

        const fn = (impl) as CallableType<CallableClass, CallableCall>;
        Object.setPrototypeOf(fn, new.target.prototype);
        return fn;
    }

}


export type FormatUtils = {
    'string': (n: FieldType) => string
    'number': (n: FieldType) => string
    'object': (n: FieldType, rec: (t: FieldType) => string) => string
    'array': (n: FieldType, rec: (t: FieldType) => string) => string
    'constraintsList': (n: string[]) => string
}


export type Format = CallableType<FormatUtils, ((n: FieldType) => string)>

  
export class FormatImpl extends Callable<FormatUtils,  ((n: FieldType) => string)>  {

    private constructor() {
      super((n: FieldType): string => {
        const lit = literalFromAttributes((n as any).attributes);
        if (lit !== undefined) return JSON.stringify(lit);
      
        const rec = (x: FieldType) => this.call(x);
    
        switch (n.fieldtype) {
          case "any": return "any";
          case "never": return "never";
          case "boolean": return "boolean";
          case "null": return "null";
          case "string": return this.string(n);
          case "number": return this.number(n);
          case "object": return this.object(n, rec);
          case "array": return this.array(n);
          case "or": {
            const kids = (n.attributes as any[]).filter(FieldType.describes) as FieldType[];
            return "(" + kids.map(rec).join(" | ") + ")";
          }
          case "and": {
            const kids = (n.attributes as any[]).filter(FieldType.describes) as FieldType[];
            return "(" + kids.map(rec).join(" & ") + ")";
          }
          case "not": {
            const kids = (n.attributes as any[]).filter(FieldType.describes) as FieldType[];
            return "not " + (kids[0] ? rec(kids[0]) : "<?>");
          }
          case "var": {
            const name = (n as any).name ?? "?";
            const bound = (n as any).bound as FieldType | undefined;
            return bound ? `${name} extends ${rec(bound)}` : name;
          }
          case "function": {
            const param = (n.attributes as any[]).find((a: any) => a.constrainttype === "param");
            const returns = (n.attributes as any[]).find((a: any) => a.constrainttype === "returns");
            const paramStr = param?.value ? rec(param.value as FieldType) : "any";
            const retStr = returns?.value ? rec(returns.value as FieldType) : "any";
            return `(${paramStr}) => ${retStr}`;
          }

        }
    });
    
    }


    ['string'](n: FieldType) {
        const attrs = (n.attributes ?? []).filter(ConstraintTypes.string.describes);
        const parts: string[] = [];
        for (const a of attrs) {
          if (a.constrainttype === "length") {
            const { min, max } = a as any;
            if (min != null && max != null) {
              parts.push(`len(${min}..${max})`);
            } else if (min != null) {
              parts.push(`len(>=${min})`);
            } else if (max != null) {
              parts.push(`len(<=${max})`);
            }
          }
          if (a.constrainttype === "matches") {
            const pat = (a as any).pattern;
            const src = pat instanceof RegExp ? pat.source : String(pat);
            parts.push(`=~"${src}"`);
          }
          if (a.constrainttype === "includes") parts.push(`has(${JSON.stringify((a as any).value)})`);
        }
        return parts.length ? "string & " + parts.join(" & ") : "string";
    }

    ['number'](n: FieldType): string {
        const attrs = (n.attributes ?? []).filter(ConstraintTypes.number.describes);
        let isInt = false;
        const parts: string[] = [];
        for (const a of attrs) {
            if (a.constrainttype === "integer") { isInt = true; continue; }
            if (a.constrainttype === "min") parts.push(`>=${(a as any).value}`);
            if (a.constrainttype === "max") parts.push(`<=${(a as any).value}`);
            if (a.constrainttype === "exclusiveMin") parts.push(`>${(a as any).value}`);
            if (a.constrainttype === "exclusiveMax") parts.push(`<${(a as any).value}`);
            if (a.constrainttype === "multipleOf") parts.push(`%(${(a as any).value})`);
            if (a.constrainttype === "range") {
              const { min, max } = a as any;
              if (min != null && max != null) parts.push(`>=${min} & <=${max}`);
              else if (min != null) parts.push(`>=${min}`);
              else if (max != null) parts.push(`<=${max}`);
            }
        }
        const base = isInt ? "int" : "number";
        return parts.length ? base + " & " + parts.join(" & ") : base;
    }

    ['object'](n: FieldType, rec: (t: FieldType) => string): string {
        const propC = find.objectProperty(n);
        const props: string[] = propC.map((p) => {
          const opt = p.optional ? "?" : "";
          const d = p.default !== undefined ? ` = ${JSON.stringify(p.default)}` : "";
          return `${p.key}${opt}: ${rec(p.value as FieldType)}${d}`;
        });

        const patts = (n.attributes ?? []).filter(ConstraintTypes.object.properties.describes) as any[];
        patts.forEach((pp: any) => {
          const key = typeof pp.key === "string" ? JSON.stringify(pp.key) : String(pp.key);
          props.push(`[key~${key}]: ${rec(pp.value as FieldType)}`);
        });

        const addl = (n.attributes ?? []).find(ConstraintTypes.object.additional.describes as any) as any;
        if (addl) props.push(addl.value === false ? "[noAdditional]" : `[additional]: ${rec(addl.value as FieldType)}`);

        const indexC = (n.attributes ?? []).filter(ConstraintTypes.object.index.describes) as any[];
        indexC.forEach((ix: any) => {
          const key = ix.key ? (typeof ix.key === "string" ? JSON.stringify(ix.key) : String(ix.key)) : "*";
          const when = ix.when ? `, when: ${rec(ix.when as FieldType)}` : "";
          props.push(`[index by:${ix.by} key:${key}${when}]: ${rec(ix.value as FieldType)}`);
        });

        return "{\n  " + props.join("\n  ") + "\n}";
    }


    ['array'](n: FieldType): string {
        // Literal arrays print as their literal JSON.
        const lit = literalFromAttributes((n as any).attributes);
        if (lit !== undefined) return JSON.stringify(lit);

        const attrs = (n.attributes ?? []).filter(ConstraintTypes.array.describes) as any[];
        const rec = (x: FieldType) => this.call(x);

        // Detect tuple form first
        const maybeTuple = find.tuple(n);
        if (maybeTuple) {
          const { pos, rest, minLen } = maybeTuple;
          const lastFixed = rest
            ? Math.max(-1, ...(pos.size ? [...pos.keys(), rest.start - 1] : [rest.start - 1]))
            : (pos.size ? Math.max(...pos.keys()) : -1);
          const parts: string[] = [];
          for (let i = 0; i <= lastFixed; i++) {
            const t = pos.get(i) ?? FieldType.any.create();
            const optional = typeof minLen === "number" ? i >= minLen : false;
            parts.push(optional ? `${rec(t)}?` : rec(t));
          }
          if (rest) parts.push(`...${rec(rest.t)}`);
          return `[${parts.join(", ")}]`;
        }

        // Find first declared element type (Array.values). If multiple, prefer the first —
        // this is just a pretty-printer, not a full normalizer.
        const values = attrs.filter(a => a.constrainttype === "values");
        const generic = values.find((v: any) => !v.range);
        const elemFT = ((generic ?? values[0])?.value ?? FieldType.any.create()) as FieldType;
        const elemStr = rec(elemFT);

        // Cardinality via Array.accumulate(Number.range)
        const acc = attrs.find(a => a.constrainttype === "accumulate");
        const len = acc?.items;
        const constraints: string[] = [];
        if (len?.min != null) constraints.push(`list.MinItems(${len.min})`);
        if (len?.max != null) constraints.push(`list.MaxItems(${len.max})`);

        const base = `[...${elemStr}]`;
        return constraints.length ? `${base} & ${constraints.join(" & ")}` : base;

    }

    ['constraintsList'](_items: string[]) {
        // Retained for interface compatibility; CUE syntax uses & operator directly
        return "";
    }



    private static instance: Format | null = null;

    public static getInstance() {
        if (this.instance === null) {
            this.instance = new FormatImpl() as unknown as Format;
        }
        return this.instance as Format ; 
    }

}

const FormatInstance = FormatImpl.getInstance(); 


export default FormatInstance as Format; 