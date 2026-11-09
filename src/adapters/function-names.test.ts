import { describe, expect, it } from 'vitest';
import {
  buildFunctionNameMap,
  collectInternalFunctionNames,
  encodeFunctionName,
  FunctionNameMappingError,
} from './function-names.js';

describe('function name mapping', () => {
  it('encodes dotted limb names into the vendor charset without mutating the internal id', () => {
    expect(encodeFunctionName('page.attach_user_page')).toBe('page__attach_user_page');
    expect(encodeFunctionName('lookup')).toBe('lookup');
  });

  it('round-trips declared tools and history names', () => {
    const map = buildFunctionNameMap(
      collectInternalFunctionNames(
        [{ name: 'page.attach_user_page' }, { name: 'ads.create_campaign' }],
        [{ toolCalls: [{ name: 'page.attach_user_page' }] }]
      )
    );
    expect(map.toVendor('page.attach_user_page')).toBe('page__attach_user_page');
    expect(map.toInternal('page__attach_user_page')).toBe('page.attach_user_page');
    expect(map.toInternal('ads__create_campaign')).toBe('ads.create_campaign');
  });

  it('refuses a collision between a dotted name and an underscore-encoded sibling', () => {
    expect(() => buildFunctionNameMap(['page.attach_user_page', 'page__attach_user_page'])).toThrow(
      FunctionNameMappingError
    );
  });

  it('refuses unknown vendor names instead of inventing an internal identity', () => {
    const map = buildFunctionNameMap(['page.attach_user_page']);
    expect(() => map.toInternal('ads__create_campaign')).toThrow(/unknown vendor function name/);
  });

  it('refuses malformed vendor names instead of decoding them', () => {
    const map = buildFunctionNameMap(['page.attach_user_page']);
    expect(() => map.toInternal('page.attach_user_page')).toThrow(/malformed vendor function name/);
    expect(() => map.toInternal('')).toThrow(/malformed vendor function name/);
  });

  it('refuses names that cannot match the vendor pattern even after encoding', () => {
    expect(() => encodeFunctionName('page.attach/user')).toThrow(FunctionNameMappingError);
    expect(() => encodeFunctionName('')).toThrow(FunctionNameMappingError);
  });
});
