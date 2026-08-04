import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { GovernanceCorpusDiscovery, GovernanceDocument } from './governance-corpus.js';

export interface GovernanceSearchResult {
  id: string;
  title: string;
  path: string;
  type: string;
  status: string;
  snippet: string;
  score: number;
  tags: string[];
}

export interface GovernanceSearchResponse {
  query: string;
  category: string | null;
  matchCount: number;
  results: GovernanceSearchResult[];
}

export class GovernanceSearchIndex {
  private readonly db: DatabaseSync;
  private readonly corpusDiscovery: GovernanceCorpusDiscovery;
  private readonly indexDir: string;

  constructor(dbPath?: string) {
    const homeDir = os.homedir();
    const defaultIndexDir = path.join(homeDir, '.xurgo', 'governance', '.index');
    this.indexDir = dbPath ? path.dirname(dbPath) : defaultIndexDir;

    if (!fs.existsSync(this.indexDir)) {
      fs.mkdirSync(this.indexDir, { recursive: true });
    }

    const actualDbPath = dbPath || path.join(this.indexDir, 'governance-search.db');
    this.db = new DatabaseSync(actualDbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.init();

    this.corpusDiscovery = new GovernanceCorpusDiscovery();
  }

  async index(): Promise<number> {
    const corpus = this.corpusDiscovery.discover();
    if (!corpus) {
      return 0;
    }

    // Drop and recreate tables for clean indexing
    this.db.exec('DROP TABLE IF EXISTS governance_search_fts');
    this.db.exec('DROP TABLE IF EXISTS governance_docs');

    this.db.exec(`
      CREATE TABLE governance_docs (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        path TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE VIRTUAL TABLE governance_search_fts USING fts5(
        title,
        content,
        tags,
        content='governance_docs',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      )
    `);

    const insertDoc = this.db.prepare(`
      INSERT INTO governance_docs (id, title, path, type, status, content, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    let indexedCount = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const doc of corpus.documents) {
        if (!doc.content) continue;

        insertDoc.run(
          doc.id,
          doc.title,
          doc.path,
          doc.type,
          doc.status,
          doc.content,
          doc.tags.join(', '),
        );
        indexedCount++;
      }

      // Rebuild FTS index from the content table
      this.db.exec('INSERT INTO governance_search_fts(governance_search_fts) VALUES(\'rebuild\')');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return indexedCount;
  }

  search(
    query: string,
    category: string | null = null,
    limit: number = 10,
  ): GovernanceSearchResponse {
    const normalizedQuery = query.trim().replace(/\s+/g, ' ');
    const ftsQuery = this.buildFtsQuery(normalizedQuery);

    if (!ftsQuery) {
      return {
        query,
        category,
        matchCount: 0,
        results: [],
      };
    }

    let sql = `
      SELECT
        d.id,
        d.title,
        d.path,
        d.type,
        d.status,
        d.content,
        d.tags,
        bm25(governance_search_fts) AS raw_score
      FROM governance_search_fts
      JOIN governance_docs d ON d.rowid = governance_search_fts.rowid
      WHERE governance_search_fts MATCH ?
    `;

    const params: any[] = [ftsQuery];

    if (category) {
      sql += ' AND d.type = ?';
      params.push(category);
    }

    sql += ' ORDER BY raw_score ASC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      title: string;
      path: string;
      type: string;
      status: string;
      content: string;
      tags: string;
      raw_score: number;
    }>;

    const results = rows.map((row) => ({
      id: row.id,
      title: row.title,
      path: row.path,
      type: row.type,
      status: row.status,
      snippet: this.buildSearchExcerpt(row.content, normalizedQuery),
      score: this.scoreFromBm25(row.raw_score),
      tags: row.tags.split(',').map(t => t.trim()),
    }));

    return {
      query,
      category,
      matchCount: results.length,
      results,
    };
  }

  close(): void {
    this.db.close();
  }

  private init(): void {
    // Tables are created in the index() method for clean state
  }

  private buildFtsQuery(query: string): string {
    const terms = this.extractSearchTerms(query);
    if (terms.length === 0) return '';
    return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' AND ');
  }

  private extractSearchTerms(query: string): string[] {
    return (query.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12);
  }

  private scoreFromBm25(score: number): number {
    const normalized = Number.isFinite(score) ? Math.max(score, 0) : 0;
    return Number((1 / (1 + normalized)).toFixed(6));
  }

  private buildSearchExcerpt(content: string, query: string): string {
    const normalizedContent = content.replace(/\s+/g, ' ').trim();
    if (normalizedContent.length === 0) return '';

    const normalizedQuery = query.trim().replace(/\s+/g, ' ');
    const candidates = new Set<string>([
      normalizedQuery,
      ...this.extractSearchTerms(normalizedQuery),
    ]);

    let matchIndex = -1;
    let matchedTerm = '';
    const lowerContent = normalizedContent.toLowerCase();

    for (const candidate of candidates) {
      const index = lowerContent.indexOf(candidate.toLowerCase());
      if (index >= 0) {
        matchIndex = index;
        matchedTerm = candidate;
        break;
      }
    }

    if (matchIndex < 0) {
      return normalizedContent.slice(0, 180);
    }

    const before = Math.max(0, matchIndex - 40);
    const after = Math.min(
      normalizedContent.length,
      matchIndex + matchedTerm.length + 80,
    );
    let excerpt = normalizedContent.slice(before, after).trim();

    if (before > 0) excerpt = `…${excerpt}`;
    if (after < normalizedContent.length) excerpt = `${excerpt}…`;

    return excerpt.replace(
      new RegExp(this.escapeRegExp(matchedTerm), 'ig'),
      (match) => `[${match}]`,
    );
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}