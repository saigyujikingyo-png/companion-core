import { SCHEMA_SQL } from './schema.ts';

// Numbered append-only migration. The schema-1 SQL is deliberately unchanged.
const batch = `
 SELECT CASE WHEN fanout_tx() IS NULL THEN RAISE(ABORT,'FANOUT_TRANSACTION_REQUIRED') END;
 INSERT INTO fanout_batches(tx_id,phase,as_of)
 SELECT fanout_tx(),fanout_phase(),fanout_asof()
 WHERE NOT EXISTS(SELECT 1 FROM fanout_batches WHERE tx_id=fanout_tx());
`;
function change(table: string, type: string, scope: string, entity: string, related: string, columns: string[]): string {
  return ['INSERT','UPDATE','DELETE'].map(op => {
    const row = op === 'DELETE' ? 'OLD' : 'NEW';
    const subst = (s: string) => s.replaceAll('$', row);
    const when = op === 'UPDATE' ? ` WHEN ${columns.map(column => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')}` : '';
    return `CREATE TRIGGER fanout_${table}_${op.toLowerCase()} AFTER ${op} ON ${table}${when} BEGIN
 ${batch}
 INSERT INTO fanout_items(batch_seq,scope_id,kind,entity_id,related_id,operation)
 SELECT seq,${subst(scope)},'${type}',${subst(entity)},${subst(related)},'${op.toLowerCase()}' FROM fanout_batches WHERE tx_id=fanout_tx();
END;`;
  }).join('\n');
}
export const SCHEMA_V2_ADDITION = `
CREATE TABLE fanout_state (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), head_seq INTEGER NOT NULL CHECK(head_seq>=0),
 floor_seq INTEGER NOT NULL CHECK(floor_seq>=0 AND floor_seq<=head_seq), last_wall INTEGER NOT NULL CHECK(last_wall>=0), next_due INTEGER
) STRICT;
INSERT INTO fanout_state VALUES (1,0,0,0,NULL);
CREATE TABLE fanout_batches (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, tx_id TEXT NOT NULL UNIQUE, phase TEXT NOT NULL, as_of INTEGER NOT NULL,
 revocation_high_water INTEGER NOT NULL DEFAULT 0, item_count INTEGER NOT NULL DEFAULT 0,
 digest TEXT NOT NULL DEFAULT '', complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1))
) STRICT;
CREATE TABLE fanout_items (
 id INTEGER PRIMARY KEY, batch_seq INTEGER NOT NULL REFERENCES fanout_batches(seq) ON DELETE CASCADE,
 scope_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('node','edge','scope','ttl')),
 entity_id TEXT NOT NULL, related_id TEXT, operation TEXT NOT NULL
) STRICT;
CREATE INDEX fanout_items_batch ON fanout_items(batch_seq,id);
CREATE TABLE fanout_consumers (
 id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(id), profile TEXT NOT NULL,
 required INTEGER NOT NULL CHECK(required IN (0,1)), generation INTEGER NOT NULL CHECK(generation>=1),
 status TEXT NOT NULL CHECK(status IN ('active','paused','reset_required')),
 applied_seq INTEGER NOT NULL CHECK(applied_seq>=0), baseline_seq INTEGER NOT NULL CHECK(baseline_seq>=0),
 authority TEXT NOT NULL, as_of INTEGER NOT NULL, next_due INTEGER
) STRICT;
CREATE TABLE fanout_projection (
 consumer_id TEXT NOT NULL REFERENCES fanout_consumers(id) ON DELETE CASCADE,
 node_id TEXT NOT NULL, revision INTEGER NOT NULL, metadata TEXT NOT NULL,
 PRIMARY KEY(consumer_id,node_id)
) STRICT;
CREATE TRIGGER fanout_nodes_identity BEFORE UPDATE ON nodes
 WHEN OLD.id IS NOT NEW.id OR OLD.scope_id IS NOT NEW.scope_id OR OLD.type IS NOT NEW.type
 BEGIN SELECT RAISE(ABORT,'FANOUT_IMMUTABLE_IDENTITY'); END;
CREATE TRIGGER fanout_scopes_identity BEFORE UPDATE ON scopes
 WHEN OLD.id IS NOT NEW.id OR OLD.identity IS NOT NEW.identity
 BEGIN SELECT RAISE(ABORT,'FANOUT_IMMUTABLE_IDENTITY'); END;
CREATE TRIGGER fanout_dependencies_identity BEFORE UPDATE ON dependencies
 WHEN OLD.child_id IS NOT NEW.child_id OR OLD.parent_id IS NOT NEW.parent_id
 BEGIN SELECT RAISE(ABORT,'FANOUT_IMMUTABLE_IDENTITY'); END;
${change('nodes','node','$.scope_id','$.id','NULL', ['id','scope_id','type','revision','generation','consent_revision','status','body','search_text','created_at','valid_from','valid_to','projection_visible'])}
${change('scopes','scope','$.id','$.id','NULL', ['id','identity','generation','consent_revision','learning_allowed','runtime_epoch'])}
${change('dependencies','edge','(SELECT scope_id FROM nodes WHERE id=$.child_id)','$.child_id','$.parent_id', ['child_id','parent_id','parent_revision'])}
CREATE TRIGGER fanout_batches_no_update BEFORE UPDATE ON fanout_batches WHEN OLD.complete=1
 BEGIN SELECT RAISE(ABORT,'FANOUT_IMMUTABLE_BATCH'); END;
CREATE TRIGGER fanout_batches_no_delete BEFORE DELETE ON fanout_batches WHEN fanout_phase()!='prune'
 BEGIN SELECT RAISE(ABORT,'FANOUT_IMMUTABLE_BATCH'); END;
CREATE TRIGGER fanout_items_no_update BEFORE UPDATE ON fanout_items
 BEGIN SELECT RAISE(ABORT,'FANOUT_IMMUTABLE_ITEM'); END;
CREATE TRIGGER fanout_items_no_insert BEFORE INSERT ON fanout_items
 WHEN (SELECT complete FROM fanout_batches WHERE seq=NEW.batch_seq)=1
 BEGIN SELECT RAISE(ABORT,'FANOUT_IMMUTABLE_ITEM'); END;
CREATE TRIGGER fanout_items_no_delete BEFORE DELETE ON fanout_items WHEN fanout_phase()!='prune'
 BEGIN SELECT RAISE(ABORT,'FANOUT_IMMUTABLE_ITEM'); END;
`;
export const SCHEMA_V2_SQL = SCHEMA_SQL + SCHEMA_V2_ADDITION;
