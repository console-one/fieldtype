/**
 * headElect.ts — @deprecated constraint election + type projection.
 *
 * These functions were originally in head.ts. Production code now uses
 * the call-overlay mechanism (Phase 2). Retained for test compatibility.
 */

import type { HEAD } from './head.js';
import { type_ } from './statement.js';

/**
 * Propagate behavioral constraints from dep bindings to an output binding.
 *
 * @deprecated Production code now uses the call-overlay mechanism (Phase 2).
 * Constraint propagation is handled inline by overlay statements.
 * This function is retained only for existing test compatibility.
 */
export function electConstraints(
  head: HEAD,
  outputName: string,
  depNames: string[],
): void {
  const PROPAGATED = ['decorator', 'visibility', 'fork'] as const;
  for (const dep of depNames) {
    for (const ct of PROPAGATED) {
      const constraint = head.value(`${dep}:${ct}`);
      if (constraint && typeof constraint === 'object') {
        if ((constraint as any).propagate === false) continue;
        head.write(type_(`${outputName}:${ct}`, { type: 'literal', value: constraint }));

        if (ct === 'decorator' && typeof (constraint as any).transform === 'string') {
          const transformName = (constraint as any).transform as string;
          const transformType = head.value(`${transformName}:type`);
          if (transformType && typeof transformType === 'object') {
            const injects = (transformType as any).injects as string[] | undefined;
            const outputType = head.value(`${outputName}:type`);
            if (injects && injects.length > 0 && outputType && typeof outputType === 'object') {
              const projected = projectServiceType(outputType, injects);
              head.write(type_(`${outputName}:type`, { type: 'literal', value: projected }));
            } else {
              head.write(type_(`${outputName}:type`, { type: 'literal', value: transformType }));
            }
          }
        }
      }
    }
  }
}

/**
 * Project a service type snapshot by masking specified input params.
 *
 * @deprecated Retained for test compatibility only.
 */
export function projectServiceType(
  typeSnapshot: any,
  maskedParams: string[],
): any {
  if (!typeSnapshot || typeSnapshot.fieldtype !== 'object' || !typeSnapshot.attributes) {
    return typeSnapshot;
  }

  const maskedSet = new Set(maskedParams);

  return {
    ...typeSnapshot,
    attributes: typeSnapshot.attributes.map((attr: any) => {
      if (attr.constrainttype !== 'property' || !attr.value) return attr;

      const methodType = attr.value;
      if (methodType.fieldtype !== 'function' || !methodType.attributes) return attr;

      const projectedAttrs = methodType.attributes.map((fnAttr: any) => {
        if (fnAttr.constrainttype !== 'param' || !fnAttr.value) return fnAttr;

        const paramType = fnAttr.value;
        if (paramType.fieldtype !== 'object' || !paramType.attributes) return fnAttr;

        const filteredProps = paramType.attributes.filter((propAttr: any) =>
          propAttr.constrainttype !== 'property' || !maskedSet.has(propAttr.key),
        );

        return {
          ...fnAttr,
          value: { ...paramType, attributes: filteredProps },
        };
      });

      return {
        ...attr,
        value: { ...methodType, attributes: projectedAttrs },
      };
    }),
  };
}
