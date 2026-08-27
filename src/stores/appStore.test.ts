import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { useAppStore } from './appStore.ts';

describe('appStore', () => {
  beforeEach(() => {
    // 重置 store 到初始状态
    useAppStore.setState({
      connections: [],
      tabs: [],
      activeTabId: null,
      connectedDbConns: new Set(),
      dbErrorConns: new Set(),
      splitOn: false,
      paneBTabIds: [],
      activeAId: null,
      activeBId: null,
      focusedPane: 'a',
    });
  });

  describe('标签页管理', () => {
    it('应该能够打开新标签页', () => {
      const store = useAppStore.getState();

      store.openTab({
        id: 'tab-1',
        connectionId: 'conn-1',
        title: '查询 1',
        type: 'query',
      });

      const state = useAppStore.getState();
      assert.strictEqual(state.tabs.length, 1);
      assert.strictEqual(state.tabs[0].id, 'tab-1');
      assert.strictEqual(state.activeTabId, 'tab-1');
    });

    it('应该能够关闭标签页', () => {
      const store = useAppStore.getState();

      store.openTab({ id: 'tab-1', connectionId: 'conn-1', title: '查询 1', type: 'query' });
      store.openTab({ id: 'tab-2', connectionId: 'conn-1', title: '查询 2', type: 'query' });

      store.closeTab('tab-1');

      const state = useAppStore.getState();
      assert.strictEqual(state.tabs.length, 1);
      assert.strictEqual(state.tabs[0].id, 'tab-2');
    });

    it('应该能够关闭其他标签页', () => {
      const store = useAppStore.getState();

      store.openTab({ id: 'tab-1', connectionId: 'conn-1', title: '查询 1', type: 'query' });
      store.openTab({ id: 'tab-2', connectionId: 'conn-1', title: '查询 2', type: 'query' });
      store.openTab({ id: 'tab-3', connectionId: 'conn-1', title: '查询 3', type: 'query' });

      store.closeOtherTabs('tab-2');

      const state = useAppStore.getState();
      assert.strictEqual(state.tabs.length, 1);
      assert.strictEqual(state.tabs[0].id, 'tab-2');
    });

    it('应该能够关闭右侧标签页', () => {
      const store = useAppStore.getState();

      store.openTab({ id: 'tab-1', connectionId: 'conn-1', title: '查询 1', type: 'query' });
      store.openTab({ id: 'tab-2', connectionId: 'conn-1', title: '查询 2', type: 'query' });
      store.openTab({ id: 'tab-3', connectionId: 'conn-1', title: '查询 3', type: 'query' });

      store.closeTabsToRight('tab-1');

      const state = useAppStore.getState();
      assert.strictEqual(state.tabs.length, 1);
      assert.strictEqual(state.tabs[0].id, 'tab-1');
    });

    it('应该能够移动标签页', () => {
      const store = useAppStore.getState();

      store.openTab({ id: 'tab-1', connectionId: 'conn-1', title: '查询 1', type: 'query' });
      store.openTab({ id: 'tab-2', connectionId: 'conn-1', title: '查询 2', type: 'query' });
      store.openTab({ id: 'tab-3', connectionId: 'conn-1', title: '查询 3', type: 'query' });

      store.moveTab('tab-3', 'tab-1', 'before');

      const state = useAppStore.getState();
      assert.strictEqual(state.tabs[0].id, 'tab-3');
      assert.strictEqual(state.tabs[1].id, 'tab-1');
      assert.strictEqual(state.tabs[2].id, 'tab-2');
    });

    it('应该能够重命名标签页', () => {
      const store = useAppStore.getState();

      store.openTab({ id: 'tab-1', connectionId: 'conn-1', title: '原标题', type: 'query' });
      store.renameTab('tab-1', '新标题');

      const state = useAppStore.getState();
      assert.strictEqual(state.tabs[0].title, '新标题');
    });

    it('不应该关闭固定标签页', () => {
      const store = useAppStore.getState();

      store.openTab({ id: 'tab-pinned', connectionId: 'conn-1', title: '固定', type: 'schema-browser', pinned: true });
      store.openTab({ id: 'tab-normal', connectionId: 'conn-1', title: '普通', type: 'query' });

      store.closeTab('tab-pinned');

      const state = useAppStore.getState();
      assert.strictEqual(state.tabs.length, 2);
      assert.ok(state.tabs.find(t => t.id === 'tab-pinned'));
    });
  });

  describe('分屏功能', () => {
    it('应该能够开启水平分屏', () => {
      const store = useAppStore.getState();

      store.openSplit('h');

      const state = useAppStore.getState();
      assert.strictEqual(state.splitOn, true);
      assert.strictEqual(state.splitDir, 'h');
      assert.strictEqual(state.splitRatio, 0.5);
    });

    it('应该能够开启垂直分屏', () => {
      const store = useAppStore.getState();

      store.openSplit('v');

      const state = useAppStore.getState();
      assert.strictEqual(state.splitOn, true);
      assert.strictEqual(state.splitDir, 'v');
    });

    it('应该能够关闭分屏', () => {
      const store = useAppStore.getState();

      store.openSplit('h');
      store.closeSplit();

      const state = useAppStore.getState();
      assert.strictEqual(state.splitOn, false);
      assert.strictEqual(state.paneBTabIds.length, 0);
    });

    it('应该能够移动标签页到副屏', () => {
      const store = useAppStore.getState();

      store.openTab({ id: 'tab-1', connectionId: 'conn-1', title: '查询 1', type: 'query' });
      store.openSplit('h');
      store.moveTabToPane('tab-1', 'b');

      const state = useAppStore.getState();
      assert.ok(state.paneBTabIds.includes('tab-1'));
      assert.strictEqual(state.activeBId, 'tab-1');
    });

    it('应该能够调整分屏比例', () => {
      const store = useAppStore.getState();

      store.openSplit('h');
      store.setSplitRatio(0.7);

      const state = useAppStore.getState();
      assert.strictEqual(state.splitRatio, 0.7);
    });

    it('分屏比例应该限制在 0.2-0.8', () => {
      const store = useAppStore.getState();

      store.openSplit('h');
      store.setSplitRatio(0.1);
      assert.strictEqual(useAppStore.getState().splitRatio, 0.2);

      store.setSplitRatio(0.9);
      assert.strictEqual(useAppStore.getState().splitRatio, 0.8);
    });
  });

  describe('连接状态管理', () => {
    it('应该能够标记数据库已连接', () => {
      const store = useAppStore.getState();

      store.markDbConnected('conn-1');

      const state = useAppStore.getState();
      assert.ok(state.connectedDbConns.has('conn-1'));
      assert.ok(!state.dbErrorConns.has('conn-1'));
    });

    it('应该能够标记数据库连接错误', () => {
      const store = useAppStore.getState();

      store.markDbError('conn-1');

      const state = useAppStore.getState();
      assert.ok(state.dbErrorConns.has('conn-1'));
      assert.ok(!state.connectedDbConns.has('conn-1'));
    });

    it('应该能够标记数据库断开连接', () => {
      const store = useAppStore.getState();

      store.markDbConnected('conn-1');
      store.markDbDisconnected('conn-1');

      const state = useAppStore.getState();
      assert.ok(!state.connectedDbConns.has('conn-1'));
      assert.ok(!state.dbErrorConns.has('conn-1'));
    });

    it('连接成功应该清除错误状态', () => {
      const store = useAppStore.getState();

      store.markDbError('conn-1');
      store.markDbConnected('conn-1');

      const state = useAppStore.getState();
      assert.ok(state.connectedDbConns.has('conn-1'));
      assert.ok(!state.dbErrorConns.has('conn-1'));
    });
  });

  describe('标签页元数据', () => {
    it('应该能够设置标签页元数据', () => {
      const store = useAppStore.getState();

      store.openTab({ id: 'tab-1', connectionId: 'conn-1', title: '查询', type: 'query' });
      store.setTabMeta('tab-1', { schema: 'public', table: 'users' });

      const state = useAppStore.getState();
      assert.strictEqual(state.tabs[0].meta?.schema, 'public');
      assert.strictEqual(state.tabs[0].meta?.table, 'users');
    });

    it('应该能够删除标签页元数据字段', () => {
      const store = useAppStore.getState();

      store.openTab({
        id: 'tab-1',
        connectionId: 'conn-1',
        title: '查询',
        type: 'query',
        meta: { schema: 'public', table: 'users' }
      });

      store.setTabMeta('tab-1', { table: undefined });

      const state = useAppStore.getState();
      assert.strictEqual(state.tabs[0].meta?.schema, 'public');
      assert.strictEqual(state.tabs[0].meta?.table, undefined);
    });

    it('应该能够标记标签页为脏状态', () => {
      const store = useAppStore.getState();

      store.openTab({ id: 'tab-1', connectionId: 'conn-1', title: '查询', type: 'query' });
      store.setTabDirty('tab-1', true);

      const state = useAppStore.getState();
      assert.strictEqual(state.tabs[0].dirty, true);
    });

    it('应该能够标记标签页错误', () => {
      const store = useAppStore.getState();

      store.openTab({ id: 'tab-1', connectionId: 'conn-1', title: '查询', type: 'query' });
      store.markTabError('tab-1');

      const state = useAppStore.getState();
      assert.strictEqual(state.tabs[0].error, true);
    });

    it('应该能够清除标签页错误', () => {
      const store = useAppStore.getState();

      store.openTab({ id: 'tab-1', connectionId: 'conn-1', title: '查询', type: 'query' });
      store.markTabError('tab-1');
      store.clearTabError('tab-1');

      const state = useAppStore.getState();
      assert.strictEqual(state.tabs[0].error, false);
    });
  });

  describe('未保存标签页检测', () => {
    it('应该识别有未保存 SQL 的查询页', () => {
      const store = useAppStore.getState();

      store.openTab({ id: 'tab-1', connectionId: 'conn-1', title: '查询', type: 'query', dirty: true });

      const unsaved = store.unsavedTabs();
      assert.strictEqual(unsaved.length, 1);
      assert.strictEqual(unsaved[0].id, 'tab-1');
    });

    it('应该识别有未保存修改的对象编辑页', () => {
      const store = useAppStore.getState();

      store.openTab({ id: 'tab-1', connectionId: 'conn-1', title: '编辑视图', type: 'object-editor', dirty: true });

      const unsaved = store.unsavedTabs();
      assert.strictEqual(unsaved.length, 1);
      assert.strictEqual(unsaved[0].id, 'tab-1');
    });

    it('不应该包含已保存的标签页', () => {
      const store = useAppStore.getState();

      store.openTab({ id: 'tab-1', connectionId: 'conn-1', title: '查询', type: 'query', dirty: false });
      store.openTab({ id: 'tab-2', connectionId: 'conn-1', title: '编辑', type: 'object-editor', dirty: false });

      const unsaved = store.unsavedTabs();
      assert.strictEqual(unsaved.length, 0);
    });
  });
});
