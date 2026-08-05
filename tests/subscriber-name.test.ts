import { describe, expect, it } from 'vitest';
import {
  cleanName,
  displayName,
  splitNameAttributes,
  subscriberMergeData,
} from '@/lib/subscriber-name';

describe('cleanName', () => {
  it('trims and rejects blanks and non-strings', () => {
    expect(cleanName('  Ada ')).toBe('Ada');
    expect(cleanName('')).toBeUndefined();
    expect(cleanName('   ')).toBeUndefined();
    expect(cleanName(42)).toBeUndefined();
    expect(cleanName(undefined)).toBeUndefined();
  });

  it('bounds the length', () => {
    expect(cleanName('x'.repeat(1000))).toHaveLength(256);
  });
});

describe('splitNameAttributes', () => {
  it('routes the name keys out of the attribute map', () => {
    const result = splitNameAttributes({
      first_name: 'Ada',
      last_name: 'Lovelace',
      company: 'Analytical Engines',
    });

    expect(result.firstName).toBe('Ada');
    expect(result.lastName).toBe('Lovelace');
    expect(result.attributes).toEqual({ company: 'Analytical Engines' });
  });

  it('prefers explicit inputs over attribute keys', () => {
    const result = splitNameAttributes(
      { first_name: 'Attribute' },
      { firstName: 'Explicit' },
    );
    expect(result.firstName).toBe('Explicit');
  });

  it('drops a blank name rather than storing it', () => {
    const result = splitNameAttributes({ first_name: '  ' });
    expect(result.firstName).toBeUndefined();
    expect(result.attributes).toEqual({});
  });
});

describe('subscriberMergeData', () => {
  it('layers first-party names over attributes', () => {
    const data = subscriberMergeData({
      firstName: 'Ada',
      lastName: 'Lovelace',
      attributes: { first_name: 'Legacy', company: 'Analytical Engines' },
    });

    expect(data.first_name).toBe('Ada');
    expect(data.last_name).toBe('Lovelace');
    expect(data.company).toBe('Analytical Engines');
  });

  it('keeps rendering legacy attribute names when the first-party field is absent', () => {
    const data = subscriberMergeData({ attributes: { first_name: 'Legacy' } });
    expect(data.first_name).toBe('Legacy');
  });

  it('derives full_name unless one was set explicitly', () => {
    expect(
      subscriberMergeData({ firstName: 'Ada', lastName: 'Lovelace', attributes: {} })
        .full_name,
    ).toBe('Ada Lovelace');
    expect(subscriberMergeData({ firstName: 'Ada', attributes: {} }).full_name).toBe('Ada');
    expect(
      subscriberMergeData({
        firstName: 'Ada',
        attributes: { full_name: 'Countess of Lovelace' },
      }).full_name,
    ).toBe('Countess of Lovelace');
    expect(subscriberMergeData({ attributes: {} }).full_name).toBeUndefined();
  });
});

describe('displayName', () => {
  it('joins the parts that exist', () => {
    expect(displayName({ firstName: 'Ada', lastName: 'Lovelace' })).toBe('Ada Lovelace');
    expect(displayName({ lastName: 'Lovelace' })).toBe('Lovelace');
    expect(displayName({})).toBeUndefined();
  });
});
