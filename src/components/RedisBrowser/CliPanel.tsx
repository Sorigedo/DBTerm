// R3 内置 Redis CLI 面板（R3.1–R3.4 含 R3.3 命令补全与内联文档）
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Terminal, Loader2 } from 'lucide-react'
import { createPortal } from 'react-dom'

interface Props { connectionId: string; db: number }

interface CliResult {
  output: string
  isDangerous: boolean
  dangerousCmd: string | null
}

interface DangerConfirm { cmd: string; resolve: (ok: boolean) => void }

const PROMPT = '> '

// R3.3 命令文档表（command → { synopsis, note }）
interface CmdDoc { synopsis: string; note: string }
const CMD_DOCS: Record<string, CmdDoc> = {
  // String
  GET:          { synopsis: 'GET key', note: '取字符串值' },
  SET:          { synopsis: 'SET key value [EX sec] [PX ms] [NX|XX] [KEEPTTL] [GET]', note: '设置键值' },
  MGET:         { synopsis: 'MGET key [key …]', note: '批量取值' },
  MSET:         { synopsis: 'MSET key value [key value …]', note: '批量设值' },
  GETSET:       { synopsis: 'GETSET key value', note: '取旧值并设新值（已废弃，推荐 SET … GET）' },
  GETEX:        { synopsis: 'GETEX key [EX sec|PX ms|EXAT ts|PXAT ts|PERSIST]', note: '取值并更新过期' },
  GETDEL:       { synopsis: 'GETDEL key', note: '取值并删除' },
  APPEND:       { synopsis: 'APPEND key value', note: '追加字符串，返回新长度' },
  STRLEN:       { synopsis: 'STRLEN key', note: '返回字符串字节长度' },
  INCR:         { synopsis: 'INCR key', note: '整数 +1' },
  INCRBY:       { synopsis: 'INCRBY key increment', note: '整数增量' },
  INCRBYFLOAT:  { synopsis: 'INCRBYFLOAT key increment', note: '浮点增量' },
  DECR:         { synopsis: 'DECR key', note: '整数 -1' },
  DECRBY:       { synopsis: 'DECRBY key decrement', note: '整数减量' },
  SETNX:        { synopsis: 'SETNX key value', note: '不存在才设值（已废弃，推荐 SET … NX）' },
  SETEX:        { synopsis: 'SETEX key seconds value', note: '设值带过期秒（已废弃，推荐 SET … EX）' },
  PSETEX:       { synopsis: 'PSETEX key ms value', note: '设值带毫秒过期（已废弃）' },
  MSETNX:       { synopsis: 'MSETNX key value [key value …]', note: '仅当所有键均不存在时批量设值' },
  SUBSTR:       { synopsis: 'SUBSTR key start end', note: '取子串（同 GETRANGE）' },
  GETRANGE:     { synopsis: 'GETRANGE key start end', note: '取子串（负下标倒数）' },
  SETRANGE:     { synopsis: 'SETRANGE key offset value', note: '覆写子串' },
  // Key
  DEL:          { synopsis: 'DEL key [key …]', note: '删除键，返回删除数量' },
  UNLINK:       { synopsis: 'UNLINK key [key …]', note: '异步删除（不阻塞）' },
  EXISTS:       { synopsis: 'EXISTS key [key …]', note: '判断键是否存在（多键返回存在数）' },
  EXPIRE:       { synopsis: 'EXPIRE key seconds [NX|XX|GT|LT]', note: '设秒级过期' },
  EXPIREAT:     { synopsis: 'EXPIREAT key unix-time-sec', note: '设绝对过期时间（Unix 秒）' },
  PEXPIRE:      { synopsis: 'PEXPIRE key milliseconds', note: '设毫秒级过期' },
  PEXPIREAT:    { synopsis: 'PEXPIREAT key unix-time-ms', note: '设绝对过期时间（Unix 毫秒）' },
  PERSIST:      { synopsis: 'PERSIST key', note: '移除过期时间，变为永久' },
  TTL:          { synopsis: 'TTL key', note: '剩余秒数（-1 永久 -2 不存在）' },
  PTTL:         { synopsis: 'PTTL key', note: '剩余毫秒数' },
  EXPIRETIME:   { synopsis: 'EXPIRETIME key', note: '过期的 Unix 秒时间戳（7.0+）' },
  PEXPIRETIME:  { synopsis: 'PEXPIRETIME key', note: '过期的 Unix 毫秒时间戳（7.0+）' },
  TYPE:         { synopsis: 'TYPE key', note: '返回键类型：string/list/set/zset/hash/stream' },
  RENAME:       { synopsis: 'RENAME key newkey', note: '重命名键' },
  RENAMENX:     { synopsis: 'RENAMENX key newkey', note: '新键不存在才重命名' },
  COPY:         { synopsis: 'COPY source destination [DB db] [REPLACE]', note: '复制键（6.2+）' },
  MOVE:         { synopsis: 'MOVE key db', note: '移动键到另一 DB' },
  DUMP:         { synopsis: 'DUMP key', note: '序列化键值（RDB 格式二进制）' },
  RESTORE:      { synopsis: 'RESTORE key ttl serialized-value [REPLACE] [ABSTTL] [IDLETIME s] [FREQ f]', note: '从 DUMP 反序列化' },
  OBJECT:       { synopsis: 'OBJECT ENCODING|REFCOUNT|IDLETIME|FREQ|HELP key', note: '查询内部元信息' },
  RANDOMKEY:    { synopsis: 'RANDOMKEY', note: '随机返回一个键名（可能阻塞）' },
  KEYS:         { synopsis: 'KEYS pattern', note: '匹配所有键（生产禁用）' },
  SCAN:         { synopsis: 'SCAN cursor [MATCH pattern] [COUNT n] [TYPE type]', note: '增量扫描键（推荐用于生产）' },
  SORT:         { synopsis: 'SORT key [BY p] [LIMIT o c] [GET p] [ASC|DESC] [ALPHA] [STORE dst]', note: '排序并可选存储结果' },
  WAIT:         { synopsis: 'WAIT numreplicas timeout', note: '等待写操作同步到副本' },
  // Hash
  HSET:         { synopsis: 'HSET key field value [field value …]', note: '设置哈希字段' },
  HGET:         { synopsis: 'HGET key field', note: '取哈希字段值' },
  HMSET:        { synopsis: 'HMSET key field value [field value …]', note: '批量设哈希字段（已废弃，用 HSET）' },
  HMGET:        { synopsis: 'HMGET key field [field …]', note: '批量取哈希字段' },
  HGETALL:      { synopsis: 'HGETALL key', note: '取全部字段与值（慎用大 hash）' },
  HDEL:         { synopsis: 'HDEL key field [field …]', note: '删除哈希字段' },
  HEXISTS:      { synopsis: 'HEXISTS key field', note: '字段是否存在' },
  HKEYS:        { synopsis: 'HKEYS key', note: '取全部字段名' },
  HVALS:        { synopsis: 'HVALS key', note: '取全部字段值' },
  HLEN:         { synopsis: 'HLEN key', note: '字段数量' },
  HINCRBY:      { synopsis: 'HINCRBY key field increment', note: '哈希字段整数增量' },
  HINCRBYFLOAT: { synopsis: 'HINCRBYFLOAT key field increment', note: '哈希字段浮点增量' },
  HSETNX:       { synopsis: 'HSETNX key field value', note: '字段不存在才设值' },
  HRANDFIELD:   { synopsis: 'HRANDFIELD key [count [WITHVALUES]]', note: '随机取字段（6.2+）' },
  HSCAN:        { synopsis: 'HSCAN key cursor [MATCH p] [COUNT n] [NOVALUES]', note: '增量扫描哈希字段' },
  // List
  LPUSH:        { synopsis: 'LPUSH key element [element …]', note: '从左侧推入，返回列表长度' },
  RPUSH:        { synopsis: 'RPUSH key element [element …]', note: '从右侧推入' },
  LPOP:         { synopsis: 'LPOP key [count]', note: '从左侧弹出（可批量）' },
  RPOP:         { synopsis: 'RPOP key [count]', note: '从右侧弹出（可批量）' },
  LRANGE:       { synopsis: 'LRANGE key start stop', note: '取下标范围内元素（0 -1 = 全部）' },
  LLEN:         { synopsis: 'LLEN key', note: '列表长度' },
  LINDEX:       { synopsis: 'LINDEX key index', note: '按下标取元素' },
  LSET:         { synopsis: 'LSET key index element', note: '按下标设值' },
  LINSERT:      { synopsis: 'LINSERT key BEFORE|AFTER pivot element', note: '在 pivot 前/后插入' },
  LREM:         { synopsis: 'LREM key count element', note: '删除 count 个匹配元素（count<0 从尾）' },
  LTRIM:        { synopsis: 'LTRIM key start stop', note: '裁剪列表保留 [start,stop]' },
  LMOVE:        { synopsis: 'LMOVE src dst LEFT|RIGHT LEFT|RIGHT', note: '原子性移动元素（6.2+）' },
  RPOPLPUSH:    { synopsis: 'RPOPLPUSH src dst', note: '从 src 右弹并左推入 dst（已废弃）' },
  LPOS:         { synopsis: 'LPOS key element [RANK r] [COUNT n] [MAXLEN m]', note: '查找元素下标（6.0.6+）' },
  BLPOP:        { synopsis: 'BLPOP key [key …] timeout', note: '阻塞左弹出' },
  BRPOP:        { synopsis: 'BRPOP key [key …] timeout', note: '阻塞右弹出' },
  BLMOVE:       { synopsis: 'BLMOVE src dst LEFT|RIGHT LEFT|RIGHT timeout', note: '阻塞 LMOVE（6.2+）' },
  // Set
  SADD:         { synopsis: 'SADD key member [member …]', note: '添加集合成员' },
  SREM:         { synopsis: 'SREM key member [member …]', note: '删除集合成员' },
  SMEMBERS:     { synopsis: 'SMEMBERS key', note: '取全部成员（慎用大集合）' },
  SISMEMBER:    { synopsis: 'SISMEMBER key member', note: '判断成员是否存在' },
  SMISMEMBER:   { synopsis: 'SMISMEMBER key member [member …]', note: '批量判断成员（6.2+）' },
  SCARD:        { synopsis: 'SCARD key', note: '集合大小' },
  SRANDMEMBER:  { synopsis: 'SRANDMEMBER key [count]', note: '随机取成员' },
  SPOP:         { synopsis: 'SPOP key [count]', note: '随机弹出成员' },
  SMOVE:        { synopsis: 'SMOVE src dst member', note: '原子移动成员' },
  SINTER:       { synopsis: 'SINTER key [key …]', note: '交集' },
  SINTERCARD:   { synopsis: 'SINTERCARD numkeys key [key …] [LIMIT n]', note: '交集大小（7.0+）' },
  SINTERSTORE:  { synopsis: 'SINTERSTORE dst key [key …]', note: '交集存入 dst' },
  SUNION:       { synopsis: 'SUNION key [key …]', note: '并集' },
  SUNIONSTORE:  { synopsis: 'SUNIONSTORE dst key [key …]', note: '并集存入 dst' },
  SDIFF:        { synopsis: 'SDIFF key [key …]', note: '差集（第一个减去其余）' },
  SDIFFSTORE:   { synopsis: 'SDIFFSTORE dst key [key …]', note: '差集存入 dst' },
  SSCAN:        { synopsis: 'SSCAN key cursor [MATCH p] [COUNT n]', note: '增量扫描集合' },
  // ZSet
  ZADD:         { synopsis: 'ZADD key [NX|XX] [GT|LT] [CH] [INCR] score member [score member …]', note: '添加有序集合成员' },
  ZREM:         { synopsis: 'ZREM key member [member …]', note: '删除成员' },
  ZSCORE:       { synopsis: 'ZSCORE key member', note: '取成员分数' },
  ZMSCORE:      { synopsis: 'ZMSCORE key member [member …]', note: '批量取分数（6.2+）' },
  ZINCRBY:      { synopsis: 'ZINCRBY key increment member', note: '成员分数增量' },
  ZRANK:        { synopsis: 'ZRANK key member [WITHSCORE]', note: '取成员排名（从小到大，0起）' },
  ZREVRANK:     { synopsis: 'ZREVRANK key member [WITHSCORE]', note: '取成员逆序排名' },
  ZRANGE:       { synopsis: 'ZRANGE key min max [BYSCORE|BYLEX] [REV] [LIMIT o c] [WITHSCORES]', note: '范围查询（6.2+ 统一语法）' },
  ZRANGEBYSCORE: { synopsis: 'ZRANGEBYSCORE key min max [WITHSCORES] [LIMIT o c]', note: '按分数范围（已废弃，用 ZRANGE … BYSCORE）' },
  ZREVRANGEBYSCORE: { synopsis: 'ZREVRANGEBYSCORE key max min [WITHSCORES] [LIMIT o c]', note: '逆序按分数范围（已废弃）' },
  ZRANGEBYLEX:  { synopsis: 'ZRANGEBYLEX key min max [LIMIT o c]', note: '按字典序范围（相同分数时）' },
  ZRANGESTORE:  { synopsis: 'ZRANGESTORE dst src min max [BYSCORE|BYLEX] [REV] [LIMIT o c]', note: '范围查询并存储（6.2+）' },
  ZRANDMEMBER:  { synopsis: 'ZRANDMEMBER key [count [WITHSCORES]]', note: '随机取成员（6.2+）' },
  ZCARD:        { synopsis: 'ZCARD key', note: '成员总数' },
  ZCOUNT:       { synopsis: 'ZCOUNT key min max', note: '指定分数范围内成员数' },
  ZLEXCOUNT:    { synopsis: 'ZLEXCOUNT key min max', note: '指定字典序范围内成员数' },
  ZPOPMIN:      { synopsis: 'ZPOPMIN key [count]', note: '弹出最低分成员' },
  ZPOPMAX:      { synopsis: 'ZPOPMAX key [count]', note: '弹出最高分成员' },
  BZPOPMIN:     { synopsis: 'BZPOPMIN key [key …] timeout', note: '阻塞弹出最低分' },
  BZPOPMAX:     { synopsis: 'BZPOPMAX key [key …] timeout', note: '阻塞弹出最高分' },
  ZMPOP:        { synopsis: 'ZMPOP numkeys key [key …] MIN|MAX [COUNT n]', note: '从多个 key 中弹出（7.0+）' },
  BZMPOP:       { synopsis: 'BZMPOP timeout numkeys key [key …] MIN|MAX [COUNT n]', note: '阻塞 ZMPOP（7.0+）' },
  ZUNIONSTORE:  { synopsis: 'ZUNIONSTORE dst numkeys key [key …] [WEIGHTS w …] [AGGREGATE SUM|MIN|MAX]', note: '有序集合并集' },
  ZINTERSTORE:  { synopsis: 'ZINTERSTORE dst numkeys key [key …] [WEIGHTS w …] [AGGREGATE SUM|MIN|MAX]', note: '有序集合交集' },
  ZDIFFSTORE:   { synopsis: 'ZDIFFSTORE dst numkeys key [key …]', note: '有序集合差集存储（6.2+）' },
  ZSCAN:        { synopsis: 'ZSCAN key cursor [MATCH p] [COUNT n]', note: '增量扫描有序集合' },
  ZREMRANGEBYSCORE: { synopsis: 'ZREMRANGEBYSCORE key min max', note: '删除指定分数范围成员' },
  ZREMRANGEBYLEX: { synopsis: 'ZREMRANGEBYLEX key min max', note: '删除指定字典序范围成员' },
  ZREMRANGEBYRANK: { synopsis: 'ZREMRANGEBYRANK key start stop', note: '删除指定排名范围成员' },
  // Stream
  XADD:         { synopsis: 'XADD key [NOMKSTREAM] [MAXLEN|MINID [=|~] t [LIMIT n]] *|id field value …', note: '追加消息到 stream' },
  XREAD:        { synopsis: 'XREAD [COUNT n] [BLOCK ms] STREAMS key [key …] id [id …]', note: '读取消息' },
  XRANGE:       { synopsis: 'XRANGE key start end [COUNT n]', note: '正序范围读取（- 最小，+ 最大）' },
  XREVRANGE:    { synopsis: 'XREVRANGE key end start [COUNT n]', note: '逆序范围读取' },
  XLEN:         { synopsis: 'XLEN key', note: 'stream 消息数量' },
  XTRIM:        { synopsis: 'XTRIM key MAXLEN|MINID [=|~] threshold [LIMIT n]', note: '修剪 stream' },
  XDEL:         { synopsis: 'XDEL key id [id …]', note: '删除指定消息' },
  XGROUP:       { synopsis: 'XGROUP CREATE|CREATECONSUMER|DELCONSUMER|DESTROY|SETID …', note: '消费者组管理' },
  XREADGROUP:   { synopsis: 'XREADGROUP GROUP group consumer [COUNT n] [BLOCK ms] [NOACK] STREAMS key … id …', note: '消费者组读取' },
  XACK:         { synopsis: 'XACK key group id [id …]', note: '确认消息' },
  XPENDING:     { synopsis: 'XPENDING key group [[IDLE min] start end count [consumer]]', note: '查询待确认消息' },
  XCLAIM:       { synopsis: 'XCLAIM key group consumer min-idle-time id [id …] [IDLE ms] [TIME ms] [RETRYCOUNT n] [FORCE] [JUSTID]', note: '转移消息所有权' },
  XAUTOCLAIM:   { synopsis: 'XAUTOCLAIM key group consumer min-idle-time start [COUNT n] [JUSTID]', note: '自动转移待确认消息（6.2+）' },
  XINFO:        { synopsis: 'XINFO CONSUMERS|GROUPS|STREAM|FULLSTREAM|HELP key …', note: 'stream 信息查询' },
  // Server
  INFO:         { synopsis: 'INFO [section]', note: '服务器信息（server/clients/memory/stats/replication/cpu/…）' },
  CONFIG:       { synopsis: 'CONFIG GET|SET|REWRITE|RESETSTAT parameter [value]', note: '服务器配置管理' },
  DBSIZE:       { synopsis: 'DBSIZE', note: '当前 DB 键数' },
  SELECT:       { synopsis: 'SELECT index', note: '切换 DB（0–15）' },
  SWAPDB:       { synopsis: 'SWAPDB db1 db2', note: '原子交换两个 DB（4.0+）' },
  FLUSHDB:      { synopsis: 'FLUSHDB [ASYNC|SYNC]', note: '清空当前 DB（危险！）' },
  FLUSHALL:     { synopsis: 'FLUSHALL [ASYNC|SYNC]', note: '清空所有 DB（极度危险！）' },
  DEBUG:        { synopsis: 'DEBUG SLEEP s | JMAP | RELOAD | …', note: '调试命令（仅开发环境）' },
  MONITOR:      { synopsis: 'MONITOR', note: '实时打印所有命令日志（高负载环境慎用）' },
  SLOWLOG:      { synopsis: 'SLOWLOG GET [n] | LEN | RESET', note: '慢查询日志' },
  CLIENT:       { synopsis: 'CLIENT ID|GETNAME|SETNAME|LIST|KILL|PAUSE|UNPAUSE|NO-EVICT|NO-TOUCH|REPLY|INFO|CACHING|TRACKING|TRACKINGINFO|GETREDIR|UNPAUSE', note: '客户端管理' },
  COMMAND:      { synopsis: 'COMMAND [COUNT|DOCS|GETKEYS|INFO|LIST|TIPS]', note: 'Redis 命令文档' },
  LATENCY:      { synopsis: 'LATENCY HISTORY|LATEST|RESET [event]', note: '延迟监控（需 latency-monitor-threshold > 0）' },
  MEMORY:       { synopsis: 'MEMORY USAGE key [SAMPLES n] | DOCTOR | STATS | PURGE | MALLOC-STATS | HELP', note: '内存分析' },
  LOLWUT:       { synopsis: 'LOLWUT [VERSION n]', note: '彩蛋（显示 Redis 版本图）' },
  SAVE:         { synopsis: 'SAVE', note: '同步持久化 RDB（会阻塞）' },
  BGSAVE:       { synopsis: 'BGSAVE [SCHEDULE]', note: '后台持久化 RDB' },
  BGREWRITEAOF: { synopsis: 'BGREWRITEAOF', note: '后台重写 AOF' },
  LASTSAVE:     { synopsis: 'LASTSAVE', note: '上次成功持久化的 Unix 时间戳' },
  REPLICAOF:    { synopsis: 'REPLICAOF host port | NO ONE', note: '设置/解除主从关系' },
  SLAVEOF:      { synopsis: 'SLAVEOF host port | NO ONE', note: 'REPLICAOF 的旧别名' },
  FAILOVER:     { synopsis: 'FAILOVER [TO host port [FORCE]] [ABORT] [TIMEOUT ms]', note: '手动主从切换（7.0+）' },
  RESET:        { synopsis: 'RESET', note: '重置当前连接状态（6.2+）' },
  SHUTDOWN:     { synopsis: 'SHUTDOWN [NOSAVE|SAVE|NOW|FORCE|ABORT]', note: '关闭服务器（极度危险！）' },
  PING:         { synopsis: 'PING [message]', note: '连通性测试，返回 PONG' },
  ECHO:         { synopsis: 'ECHO message', note: '回显消息' },
  QUIT:         { synopsis: 'QUIT', note: '关闭当前连接' },
  AUTH:         { synopsis: 'AUTH [username] password', note: '身份验证' },
  // Transaction
  MULTI:        { synopsis: 'MULTI', note: '开启事务（QUEUED）' },
  EXEC:         { synopsis: 'EXEC', note: '执行事务' },
  DISCARD:      { synopsis: 'DISCARD', note: '放弃事务' },
  WATCH:        { synopsis: 'WATCH key [key …]', note: '乐观锁：监视键，EXEC 前变更则事务取消' },
  UNWATCH:      { synopsis: 'UNWATCH', note: '取消所有 WATCH' },
  // Pub/Sub
  SUBSCRIBE:    { synopsis: 'SUBSCRIBE channel [channel …]', note: '订阅频道' },
  UNSUBSCRIBE:  { synopsis: 'UNSUBSCRIBE [channel …]', note: '取消订阅' },
  PUBLISH:      { synopsis: 'PUBLISH channel message', note: '发布消息到频道' },
  PSUBSCRIBE:   { synopsis: 'PSUBSCRIBE pattern [pattern …]', note: '模式订阅' },
  PUNSUBSCRIBE: { synopsis: 'PUNSUBSCRIBE [pattern …]', note: '取消模式订阅' },
  PUBSUB:       { synopsis: 'PUBSUB CHANNELS|NUMSUB|NUMPAT|SHARDCHANNELS|SHARDNUMSUB [arg]', note: '发布订阅状态查询' },
  SSUBSCRIBE:   { synopsis: 'SSUBSCRIBE shardchannel [shardchannel …]', note: '分片订阅（7.0+）' },
  SUNSUBSCRIBE: { synopsis: 'SUNSUBSCRIBE [shardchannel …]', note: '取消分片订阅（7.0+）' },
  SPUBLISH:     { synopsis: 'SPUBLISH shardchannel message', note: '发布到分片频道（7.0+）' },
  // Scripting
  EVAL:         { synopsis: 'EVAL script numkeys key [key …] arg [arg …]', note: '执行 Lua 脚本' },
  EVALSHA:      { synopsis: 'EVALSHA sha1 numkeys key [key …] arg [arg …]', note: '按 SHA1 执行已缓存 Lua' },
  SCRIPT:       { synopsis: 'SCRIPT FLUSH [ASYNC|SYNC] | LOAD script | EXISTS sha1 [sha1 …]', note: 'Lua 脚本管理' },
  FCALL:        { synopsis: 'FCALL function numkeys key [key …] arg [arg …]', note: '调用 Function（7.0+）' },
  FUNCTION:     { synopsis: 'FUNCTION LOAD [REPLACE] code | LIST | DELETE name | DUMP | RESTORE … | STATS | FLUSH', note: 'Redis Function 管理（7.0+）' },
  // Geo
  GEOADD:       { synopsis: 'GEOADD key [NX|XX] [CH] lon lat member [lon lat member …]', note: '添加地理坐标' },
  GEODIST:      { synopsis: 'GEODIST key member1 member2 [m|km|mi|ft]', note: '计算两点距离' },
  GEOPOS:       { synopsis: 'GEOPOS key member [member …]', note: '取成员坐标' },
  GEOSEARCH:    { synopsis: 'GEOSEARCH key FROMMEMBER m|FROMLONLAT lon lat BYRADIUS r m|km … [ASC|DESC] [COUNT n] [WITHCOORD] [WITHDIST] [WITHHASH]', note: '范围搜索（6.2+）' },
  GEOSEARCHSTORE: { synopsis: 'GEOSEARCHSTORE dst key … [STOREDIST]', note: '范围搜索并存储（6.2+）' },
  GEORADIUS:    { synopsis: 'GEORADIUS key lon lat radius m|km|mi|ft …', note: '按半径搜索（已废弃，用 GEOSEARCH）' },
  GEORADIUSBYMEMBER: { synopsis: 'GEORADIUSBYMEMBER key member radius m|km|mi|ft …', note: '按成员半径搜索（已废弃）' },
  GEOHASH:      { synopsis: 'GEOHASH key member [member …]', note: '取 Geohash 字符串' },
  // HyperLogLog
  PFADD:        { synopsis: 'PFADD key element [element …]', note: '添加元素到 HyperLogLog' },
  PFCOUNT:      { synopsis: 'PFCOUNT key [key …]', note: '估算基数（允许误差 ~0.81%）' },
  PFMERGE:      { synopsis: 'PFMERGE dst key [key …]', note: '合并多个 HyperLogLog' },
  // Bitmap
  SETBIT:       { synopsis: 'SETBIT key offset value', note: '设置指定位' },
  GETBIT:       { synopsis: 'GETBIT key offset', note: '取指定位' },
  BITCOUNT:     { synopsis: 'BITCOUNT key [start end [BYTE|BIT]]', note: '统计置位数量' },
  BITOP:        { synopsis: 'BITOP AND|OR|XOR|NOT dst key [key …]', note: '位运算' },
  BITPOS:       { synopsis: 'BITPOS key bit [start [end [BYTE|BIT]]]', note: '查找第一个 0 或 1 的位置' },
  BITFIELD:     { synopsis: 'BITFIELD key [GET t o] [SET t o v] [INCRBY t o i] [OVERFLOW WRAP|SAT|FAIL]', note: '任意位宽整数读写' },
  BITFIELD_RO:  { synopsis: 'BITFIELD_RO key [GET t o]', note: 'BITFIELD 只读版（6.0+）' },
  // Cluster
  CLUSTER:      { synopsis: 'CLUSTER INFO|NODES|SLOTS|SHARDS|MYID|MEET|RESET|FORGET|FAILOVER|…', note: '集群管理命令' },
  READONLY:     { synopsis: 'READONLY', note: '集群只读模式（允许读副本）' },
  READWRITE:    { synopsis: 'READWRITE', note: '退出集群只读模式' },
  // ACL
  ACL:          { synopsis: 'ACL WHOAMI|LIST|USERS|GETUSER u|SETUSER u rules|DELUSER u|CAT [c]|GENPASS [n]|LOG [COUNT n|RESET]|SAVE|LOAD|HELP', note: '访问控制列表管理' },
  // Misc
  WAITAOF:      { synopsis: 'WAITAOF numlocal numreplicas timeout', note: '等待 AOF 同步（7.2+）' },
  LMPOP:        { synopsis: 'LMPOP numkeys key [key …] LEFT|RIGHT [COUNT n]', note: '从多个 key 中弹出（7.0+）' },
  BLMPOP:       { synopsis: 'BLMPOP timeout numkeys key [key …] LEFT|RIGHT [COUNT n]', note: '阻塞 LMPOP（7.0+）' },
}

const CMD_LIST = Object.keys(CMD_DOCS).sort()

function formatResult(output: string): React.ReactNode {
  if (!output) return null
  const lines = output.split('\n')
  return lines.map((line, i) => {
    let color = 'var(--text)'
    if (line.startsWith('(error)') || line.startsWith('ERR') || line.startsWith('WRONGTYPE')) color = '#dc2626'
    else if (line.startsWith('(integer)')) color = '#22c55e'
    else if (line.startsWith('(nil)')) color = 'var(--text-muted)'
    else if (/^\d+\)/.test(line)) color = 'var(--text-muted)'
    return <div key={i} style={{ color, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{line || ' '}</div>
  })
}

export default function CliPanel({ connectionId, db }: Props) {
  const [history,   setHistory]   = useState<{ cmd: string; output: string }[]>([])
  const [input,     setInput]     = useState('')
  const [loading,   setLoading]   = useState(false)
  const [histIdx,   setHistIdx]   = useState(-1)
  const [inputHist, setInputHist] = useState<string[]>([])
  const [danger,    setDanger]    = useState<DangerConfirm | null>(null)
  // R3.3 autocomplete state
  const [acItems,   setAcItems]   = useState<string[]>([])
  const [acIdx,     setAcIdx]     = useState(0)
  const [showAc,    setShowAc]    = useState(false)

  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLInputElement>(null)
  const acRef     = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [history])

  // R3.3: update autocomplete suggestions when input changes
  useEffect(() => {
    const parts = input.trimStart().split(/\s+/)
    const first = parts[0]?.toUpperCase() ?? ''
    const hasSpace = input.trimStart().includes(' ')
    if (!first || hasSpace) {
      setShowAc(false)
      setAcItems([])
      return
    }
    const matches = CMD_LIST.filter(c => c.startsWith(first) && c !== first)
    setAcItems(matches.slice(0, 8))
    setAcIdx(0)
    setShowAc(matches.length > 0)
  }, [input])

  // R3.3: inline doc for the current command
  const inlineDoc = useMemo(() => {
    const trimmed = input.trimStart()
    const spaceIdx = trimmed.search(/\s/)
    if (spaceIdx < 0) return null   // still typing command name, not after space yet
    const cmd = trimmed.slice(0, spaceIdx).toUpperCase()
    return CMD_DOCS[cmd] ?? null
  }, [input])

  const execCmd = useCallback(async (raw: string, confirmed = false) => {
    const cmd = raw.trim()
    if (!cmd) return
    setLoading(true)
    setShowAc(false)
    try {
      const res = await invoke<CliResult>('redis_cli_exec', {
        id: connectionId, command: cmd, db, confirmed,
      })
      if (res.isDangerous && !confirmed) {
        const ok = await new Promise<boolean>(resolve => {
          setDanger({ cmd: res.dangerousCmd ?? cmd, resolve })
        })
        setDanger(null)
        if (!ok) {
          setHistory(prev => [...prev, { cmd, output: '(已取消)' }])
          setLoading(false)
          return
        }
        const res2 = await invoke<CliResult>('redis_cli_exec', {
          id: connectionId, command: cmd, db, confirmed: true,
        })
        setHistory(prev => [...prev, { cmd, output: res2.output }])
      } else {
        setHistory(prev => [...prev, { cmd, output: res.output }])
      }
      setInputHist(prev => [cmd, ...prev.slice(0, 99)])
    } catch (e) {
      setHistory(prev => [...prev, { cmd, output: `(error) ${String(e)}` }])
    }
    setLoading(false)
    setHistIdx(-1)
    setInput('')
  }, [connectionId, db])

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // R3.3: autocomplete key handling
    if (showAc) {
      if (e.key === 'Tab' || e.key === 'ArrowRight') {
        e.preventDefault()
        const chosen = acItems[acIdx]
        if (chosen) {
          setInput(chosen + ' ')
          setShowAc(false)
        }
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAcIdx(i => (i - 1 + acItems.length) % acItems.length)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAcIdx(i => (i + 1) % acItems.length)
        return
      }
      if (e.key === 'Escape') {
        setShowAc(false)
        return
      }
    }

    if (e.key === 'Enter') {
      execCmd(input)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const next = Math.min(histIdx + 1, inputHist.length - 1)
      setHistIdx(next)
      setInput(inputHist[next] ?? '')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = histIdx - 1
      if (next < 0) { setHistIdx(-1); setInput('') }
      else { setHistIdx(next); setInput(inputHist[next] ?? '') }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault()
      setHistory([])
    }
  }

  return (
    <div
      className="redis-cli-panel"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'var(--font-mono)' }}
      onClick={() => inputRef.current?.focus()}
    >
      <div className="redis-type-toolbar" style={{ gap: 6, flexShrink: 0 }}>
        <Terminal size={13} strokeWidth={2} style={{ color: 'var(--accent)' }} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Redis CLI — DB {db}</span>
        <span style={{ flex: 1 }} />
        <button
          className="ssh-panel__btn ssh-panel__btn--text"
          title="清空（Ctrl+L）"
          onClick={e => { e.stopPropagation(); setHistory([]) }}
        >清空</button>
      </div>

      <div
        style={{
          flex: 1, overflowY: 'auto', padding: '8px 12px',
          background: 'var(--bg)', fontSize: 12,
        }}
      >
        {history.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            输入 Redis 命令并按 Enter 执行。↑/↓ 历史，Tab 补全，Ctrl+L 清屏。
          </div>
        )}
        {history.map((h, i) => (
          <div key={i} style={{ marginBottom: 6 }}>
            <div style={{ color: 'var(--accent)', marginBottom: 2 }}>{PROMPT}{h.cmd}</div>
            <div style={{ paddingLeft: 12 }}>{formatResult(h.output)}</div>
          </div>
        ))}
        {loading && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--text-muted)' }}>
            <Loader2 size={12} className="spin" /> 执行中…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* R3.3 inline doc hint */}
      {inlineDoc && (
        <div style={{
          padding: '3px 12px', background: 'var(--surface)',
          borderTop: '1px solid var(--border-subtle)',
          fontSize: 11, color: 'var(--text-muted)',
          display: 'flex', gap: 8, alignItems: 'baseline',
          fontFamily: 'var(--font-mono)', lineHeight: 1.5,
        }}>
          <span style={{ color: 'var(--accent)', flexShrink: 0 }}>{inlineDoc.synopsis}</span>
          <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>—</span>
          <span>{inlineDoc.note}</span>
        </div>
      )}

      <div style={{ position: 'relative' }}>
        {/* R3.3 autocomplete dropdown */}
        {showAc && acItems.length > 0 && (
          <div
            ref={acRef}
            style={{
              position: 'absolute', bottom: '100%', left: 0, right: 0,
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
              zIndex: 100, overflow: 'hidden', maxHeight: 200, overflowY: 'auto',
            }}
          >
            {acItems.map((cmd, i) => (
              <div
                key={cmd}
                onMouseDown={e => { e.preventDefault(); setInput(cmd + ' '); setShowAc(false); inputRef.current?.focus() }}
                style={{
                  padding: '4px 10px', cursor: 'pointer', fontSize: 12,
                  background: i === acIdx ? 'var(--surface-hover)' : 'transparent',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                }}
                onMouseEnter={() => setAcIdx(i)}
              >
                <span style={{ color: 'var(--text-bright)', fontWeight: 500 }}>{cmd}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {CMD_DOCS[cmd]?.note}
                </span>
              </div>
            ))}
          </div>
        )}

        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '6px 12px', borderTop: '1px solid var(--border-subtle)',
            background: 'var(--surface)',
          }}
        >
          <span style={{ color: 'var(--accent)', fontSize: 13, fontFamily: 'var(--font-mono)' }}>{PROMPT}</span>
          <input
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            disabled={loading}
            autoFocus
            spellCheck={false}
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              color: 'var(--text-bright)', fontSize: 12, fontFamily: 'var(--font-mono)',
            }}
            placeholder="输入命令，如 INFO server…"
          />
        </div>
      </div>

      {/* 危险命令确认弹窗 */}
      {danger && createPortal(
        <div className="cdlg-overlay" onMouseDown={() => danger.resolve(false)}>
          <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}>
            <div className="cdlg-head">
              <Terminal size={15} className="cdlg-head__icon cdlg-head__icon--danger" />
              <span className="cdlg-head__title" style={{ color: 'var(--error)' }}>危险命令确认</span>
            </div>
            <p className="cdlg-desc">
              命令 <code style={{ color: 'var(--error)', background: 'var(--error-bg)', padding: '1px 5px', borderRadius: 4 }}>
                {danger.cmd}
              </code> 可能造成不可逆影响。确认继续执行？
            </p>
            <div className="cdlg-foot">
              <button className="cdlg-btn cdlg-btn--cancel" onClick={() => danger.resolve(false)}>取消</button>
              <button
                className="cdlg-btn cdlg-btn--danger"
                onClick={() => danger.resolve(true)}
              >强制执行</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
