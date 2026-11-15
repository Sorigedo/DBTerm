export type MigrationContent = 'both' | 'structure' | 'data'
export type MigrationStrategy = 'replace' | 'truncate' | 'append' | 'skip'

export function supportedMigrationStrategies(content: MigrationContent): MigrationStrategy[] {
  return content === 'data'
    ? ['replace', 'truncate', 'append', 'skip']
    : ['replace', 'skip']
}
