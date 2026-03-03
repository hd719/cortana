import { vi } from 'vitest';

vi.mock('@prisma/client', () => {
  class PrismaClient {
    $queryRawUnsafe = vi.fn();
    $executeRawUnsafe = vi.fn();
  }
  return { PrismaClient };
});

describe('tools/lib/db', () => {
  it('exports prisma compatibility object', async () => {
    const { prisma } = await import('../../tools/lib/db');
    expect(prisma).toBeDefined();
    expect(typeof prisma).toBe('object');
  });

  it('exports query/queryJson/execute wrappers as functions', async () => {
    const { query, queryJson, execute } = await import('../../tools/lib/db');
    expect(typeof query).toBe('function');
    expect(typeof queryJson).toBe('function');
    expect(typeof execute).toBe('function');
  });
});
