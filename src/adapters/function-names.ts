/**
 * Provider-boundary function-name codec. Internal limb ids (may contain `.`)
 * stay unchanged in Proba contracts. Vendor names must match DeepSeek's
 * documented `^[a-zA-Z0-9_-]+$` with max length 128.
 *
 * `.` is encoded as `__`. Maps are built from the declared tool list plus
 * names already present in the message history so reverse mapping cannot
 * invent a different internal identity.
 */

export const VENDOR_FUNCTION_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
export const VENDOR_FUNCTION_NAME_MAX = 128;
const DOT_ENCODE = '__';

export class FunctionNameMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FunctionNameMappingError';
  }
}

export interface FunctionNameMap {
  toVendor(internal: string): string;
  toInternal(vendor: string): string;
}

export function encodeFunctionName(internal: string): string {
  if (typeof internal !== 'string' || internal.length === 0) {
    throw new FunctionNameMappingError('function name is empty');
  }
  const encoded = internal.replaceAll('.', DOT_ENCODE);
  if (encoded.length > VENDOR_FUNCTION_NAME_MAX || !VENDOR_FUNCTION_NAME_PATTERN.test(encoded)) {
    throw new FunctionNameMappingError('function name cannot be expressed for the vendor');
  }
  return encoded;
}

export function buildFunctionNameMap(internalNames: Iterable<string>): FunctionNameMap {
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  for (const internal of internalNames) {
    const vendor = encodeFunctionName(internal);
    const existingVendor = forward.get(internal);
    if (existingVendor !== undefined && existingVendor !== vendor) {
      throw new FunctionNameMappingError('function name mapping is inconsistent');
    }
    const existingInternal = reverse.get(vendor);
    if (existingInternal !== undefined && existingInternal !== internal) {
      throw new FunctionNameMappingError('function name mapping collision');
    }
    forward.set(internal, vendor);
    reverse.set(vendor, internal);
  }
  return {
    toVendor(internal: string): string {
      const mapped = forward.get(internal);
      if (mapped) return mapped;
      const vendor = encodeFunctionName(internal);
      const owner = reverse.get(vendor);
      if (owner !== undefined && owner !== internal) {
        throw new FunctionNameMappingError('function name mapping collision');
      }
      return vendor;
    },
    toInternal(vendor: string): string {
      if (
        typeof vendor !== 'string' ||
        vendor.length === 0 ||
        vendor.length > VENDOR_FUNCTION_NAME_MAX ||
        !VENDOR_FUNCTION_NAME_PATTERN.test(vendor)
      ) {
        throw new FunctionNameMappingError('malformed vendor function name');
      }
      const mapped = reverse.get(vendor);
      if (mapped) return mapped;
      throw new FunctionNameMappingError('unknown vendor function name');
    },
  };
}

export function collectInternalFunctionNames(
  tools?: Array<{ name: string }>,
  messages?: Array<{ toolCalls?: Array<{ name: string }> }>
): string[] {
  const names = new Set<string>();
  for (const tool of tools ?? []) names.add(tool.name);
  for (const message of messages ?? []) {
    for (const call of message.toolCalls ?? []) names.add(call.name);
  }
  return [...names];
}
