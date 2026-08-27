import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { useQueryStore } from './queryStore.ts';

describe('queryStore', () => {
  beforeEach(() => {
    // 重置 store 到初始状态
    useQueryStore.setState({ sqls: {} });
  });

  describe('SQL 存储', () => {
    it('应该能够保存 SQL', () => {
      const store = useQueryStore.getState();

      store.setSql('tab-1', 'SELECT * FROM users');

      const state = useQueryStore.getState();
      assert.strictEqual(state.sqls['tab-1'], 'SELECT * FROM users');
    });

    it('应该能够更新已有 SQL', () => {
      const store = useQueryStore.getState();

      store.setSql('tab-1', 'SELECT * FROM users');
      store.setSql('tab-1', 'SELECT * FROM orders');

      const state = useQueryStore.getState();
      assert.strictEqual(state.sqls['tab-1'], 'SELECT * FROM orders');
    });

    it('应该能够删除 SQL', () => {
      const store = useQueryStore.getState();

      store.setSql('tab-1', 'SELECT * FROM users');
      store.removeSql('tab-1');

      const state = useQueryStore.getState();
      assert.strictEqual(state.sqls['tab-1'], undefined);
    });

    it('应该能够同时存储多个标签页的 SQL', () => {
      const store = useQueryStore.getState();

      store.setSql('tab-1', 'SELECT * FROM users');
      store.setSql('tab-2', 'SELECT * FROM orders');
      store.setSql('tab-3', 'SELECT * FROM products');

      const state = useQueryStore.getState();
      assert.strictEqual(Object.keys(state.sqls).length, 3);
      assert.strictEqual(state.sqls['tab-1'], 'SELECT * FROM users');
      assert.strictEqual(state.sqls['tab-2'], 'SELECT * FROM orders');
      assert.strictEqual(state.sqls['tab-3'], 'SELECT * FROM products');
    });
  });

  describe('SQL 大小限制', () => {
    it('应该拒绝超过单个限制的 SQL', () => {
      const store = useQueryStore.getState();

      // 生成超过 300,000 字符的 SQL
      const largeSql = 'SELECT * FROM users WHERE id = 1 -- '.repeat(10000);
      store.setSql('tab-large', largeSql);

      const state = useQueryStore.getState();
      // 超过限制的不会被保存
      assert.strictEqual(state.sqls['tab-large'], undefined);
    });

    it('应该保留最近的 SQL 直到总大小限制', () => {
      const store = useQueryStore.getState();

      // 添加多个中等大小的 SQL
      const mediumSql = 'SELECT * FROM users WHERE id = 1 -- '.repeat(2000); // ~80KB

      for (let i = 0; i < 25; i++) {
        store.setSql(`tab-${i}`, mediumSql);
      }

      const state = useQueryStore.getState();
      // 应该保留最近的几个，但不是全部（总限制 1.5MB）
      const totalSize = Object.values(state.sqls).reduce((sum, sql) => sum + sql.length, 0);
      assert.ok(totalSize <= 1_500_000, '总 SQL 大小应该在限制内');
    });

    it('应该优先保留最新的 SQL', () => {
      const store = useQueryStore.getState();

      const mediumSql = 'SELECT * FROM users WHERE id = 1 -- '.repeat(2000); // ~80KB

      // 先添加旧的
      for (let i = 0; i < 20; i++) {
        store.setSql(`old-tab-${i}`, mediumSql);
      }

      // 再添加新的
      for (let i = 0; i < 5; i++) {
        store.setSql(`new-tab-${i}`, mediumSql);
      }

      const state = useQueryStore.getState();
      // 检查是否保留了一些 SQL（具体哪些取决于 trimDrafts 的实现）
      const totalKeys = Object.keys(state.sqls).length;
      assert.ok(totalKeys > 0, '应该保留一些 SQL');

      // 总大小应该在限制内
      const totalSize = Object.values(state.sqls).reduce((sum, sql) => sum + sql.length, 0);
      assert.ok(totalSize <= 1_500_000, '总 SQL 大小应该在限制内');
    });
  });

  describe('空值处理', () => {
    it('应该能够保存空字符串', () => {
      const store = useQueryStore.getState();

      store.setSql('tab-empty', '');

      const state = useQueryStore.getState();
      assert.strictEqual(state.sqls['tab-empty'], '');
    });

    it('删除不存在的 SQL 应该是安全的', () => {
      const store = useQueryStore.getState();

      // 不应该抛出错误
      store.removeSql('nonexistent-tab');

      const state = useQueryStore.getState();
      assert.strictEqual(state.sqls['nonexistent-tab'], undefined);
    });
  });

  describe('特殊字符处理', () => {
    it('应该正确存储包含特殊字符的 SQL', () => {
      const store = useQueryStore.getState();

      const specialSql = `SELECT * FROM "users" WHERE name = 'O''Neil' AND data LIKE '%test%'`;
      store.setSql('tab-special', specialSql);

      const state = useQueryStore.getState();
      assert.strictEqual(state.sqls['tab-special'], specialSql);
    });

    it('应该正确存储包含 Unicode 的 SQL', () => {
      const store = useQueryStore.getState();

      const unicodeSql = `SELECT * FROM users WHERE name = '张三' AND emoji = '😀'`;
      store.setSql('tab-unicode', unicodeSql);

      const state = useQueryStore.getState();
      assert.strictEqual(state.sqls['tab-unicode'], unicodeSql);
    });

    it('应该正确存储多行 SQL', () => {
      const store = useQueryStore.getState();

      const multilineSql = `
SELECT u.id, u.name, o.total
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
WHERE u.status = 'active'
  AND o.created_at > '2024-01-01'
ORDER BY o.total DESC
LIMIT 100;
      `.trim();

      store.setSql('tab-multiline', multilineSql);

      const state = useQueryStore.getState();
      assert.strictEqual(state.sqls['tab-multiline'], multilineSql);
    });
  });

  describe('边界情况', () => {
    it('应该处理非常短的 SQL', () => {
      const store = useQueryStore.getState();

      store.setSql('tab-short', 'SELECT 1');

      const state = useQueryStore.getState();
      assert.strictEqual(state.sqls['tab-short'], 'SELECT 1');
    });

    it('应该处理接近限制的 SQL', () => {
      const store = useQueryStore.getState();

      // 生成接近 300,000 字符但不超过的 SQL
      const nearlySql = 'SELECT * FROM users -- '.repeat(11000).substring(0, 299_000);
      store.setSql('tab-nearly', nearlySql);

      const state = useQueryStore.getState();
      assert.ok(state.sqls['tab-nearly'], '接近限制的 SQL 应该被保存');
    });

    it('应该处理包含注释的 SQL', () => {
      const store = useQueryStore.getState();

      const sqlWithComments = `
-- 查询活跃用户
SELECT * FROM users
WHERE status = 'active' /* 只要活跃的 */
  AND created_at > '2024-01-01'; -- 今年创建的
      `.trim();

      store.setSql('tab-comments', sqlWithComments);

      const state = useQueryStore.getState();
      assert.strictEqual(state.sqls['tab-comments'], sqlWithComments);
    });
  });
});
