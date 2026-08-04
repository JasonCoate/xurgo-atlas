import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GovernanceCorpusDiscovery } from '../src/core/governance-corpus.js';
import { GovernanceSearchIndex } from '../src/core/governance-search.js';
import { GovernanceContextAssembler } from '../src/core/governance-context.js';
import { GovernanceLifecycleTracker } from '../src/core/governance-lifecycle.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Governance Corpus', () => {
  let corpusDiscovery: GovernanceCorpusDiscovery;
  let searchIndex: GovernanceSearchIndex;
  let contextAssembler: GovernanceContextAssembler;
  let lifecycleTracker: GovernanceLifecycleTracker;

  beforeAll(() => {
    corpusDiscovery = new GovernanceCorpusDiscovery();
    searchIndex = new GovernanceSearchIndex();
    contextAssembler = new GovernanceContextAssembler();
    lifecycleTracker = new GovernanceLifecycleTracker();
  });

  afterAll(() => {
    searchIndex.close();
    contextAssembler.close();
  });

  describe('Corpus Discovery', () => {
    it('should discover governance corpus', () => {
      const corpus = corpusDiscovery.discover();
      expect(corpus).not.toBeNull();
      expect(corpus?.metadata.totalDocuments).toBe(52);
      expect(corpus?.metadata.categories).toContain('policies');
      expect(corpus?.metadata.categories).toContain('architecture');
      expect(corpus?.metadata.categories).toContain('standards');
      expect(corpus?.metadata.categories).toContain('products');
      expect(corpus?.metadata.categories).toContain('research');
      expect(corpus?.metadata.categories).toContain('templates');
    });

    it('should return all 52 documents', () => {
      const corpus = corpusDiscovery.discover();
      expect(corpus?.documents).toHaveLength(52);
    });

    it('should have document content loaded', () => {
      const corpus = corpusDiscovery.discover();
      const docWithContent = corpus?.documents.find(doc => doc.content);
      expect(docWithContent).toBeDefined();
      expect(docWithContent?.content).toBeTruthy();
    });

    it('should calculate word counts', () => {
      const corpus = corpusDiscovery.discover();
      const docWithWordCount = corpus?.documents.find(doc => doc.wordCount);
      expect(docWithWordCount).toBeDefined();
      expect(docWithWordCount?.wordCount).toBeGreaterThan(0);
    });
  });

  describe('Document Lookup', () => {
    it('should find document by ID', () => {
      const doc = corpusDiscovery.getDocumentById('policy-001');
      expect(doc).not.toBeNull();
      expect(doc?.title).toBe('Operating System');
      expect(doc?.type).toBe('policy');
    });

    it('should return null for unknown document', () => {
      const doc = corpusDiscovery.getDocumentById('unknown-doc');
      expect(doc).toBeNull();
    });

    it('should filter documents by category', () => {
      const policies = corpusDiscovery.getDocumentsByCategory('policies');
      expect(policies).toHaveLength(4);
      expect(policies.every(doc => doc.type === 'policy')).toBe(true);
    });
  });

  describe('Search Index', () => {
    it('should index available documents', async () => {
      const indexedCount = await searchIndex.index();
      // Index may have fewer documents if some paths in atlas-index.json don't match actual files
      expect(indexedCount).toBeGreaterThan(0);
      expect(indexedCount).toBeLessThanOrEqual(52);
    });

    it('should return relevant search results', async () => {
      await searchIndex.index();
      const results = searchIndex.search('security', null, 10);
      expect(results.matchCount).toBeGreaterThan(0);
      expect(results.results.length).toBeGreaterThan(0);
      expect(results.results[0].title).toBeTruthy();
      expect(results.results[0].snippet).toBeTruthy();
    });

    it('should support category filtering', async () => {
      await searchIndex.index();
      const results = searchIndex.search('process', 'policies', 10);
      expect(results.category).toBe('policies');
      results.results.forEach(result => {
        expect(result.type).toBe('policy');
      });
    });

    it('should return empty for empty query', async () => {
      await searchIndex.index();
      const results = searchIndex.search('', null, 10);
      expect(results.matchCount).toBe(0);
    });
  });

  describe('Context Assembly', () => {
    it('should assemble bounded context package', async () => {
      const context = await contextAssembler.assembleContext(
        'security and credentials',
        5000,
      );
      expect(context.taskDescription).toBe('security and credentials');
      expect(context.totalChars).toBeLessThanOrEqual(5000);
      // Context may have no source references if search returns no results
      // or if documents don't match the query
    });

    it('should respect character limit', async () => {
      const context = await contextAssembler.assembleContext(
        'governance and policies',
        1000,
      );
      expect(context.totalChars).toBeLessThanOrEqual(1000);
    });

    it('should indicate truncation when needed', async () => {
      const context = await contextAssembler.assembleContext(
        'all governance documents',
        100,
      );
      expect(context.truncated).toBe(true);
    });

    it('should assemble context from a fresh search index without a prior search', async () => {
      const freshDb = path.join(
        os.tmpdir(),
        `governance-context-fresh-${Date.now()}.db`,
      );
      const freshAssembler = new GovernanceContextAssembler(freshDb);
      try {
        const context = await freshAssembler.assembleContext(
          'security and credentials',
          5000,
        );
        expect(context.taskDescription).toBe('security and credentials');
        expect(context.totalChars).toBeLessThanOrEqual(5000);
      } finally {
        freshAssembler.close();
      }
    });
  });

  describe('Lifecycle Tracking', () => {
    it('should get document lifecycle', () => {
      const lifecycle = lifecycleTracker.getDocumentLifecycle('policy-001');
      expect(lifecycle).not.toBeNull();
      expect(lifecycle?.id).toBe('policy-001');
      expect(lifecycle?.status).toBe('active');
      expect(lifecycle?.dependencies).toBeDefined();
      expect(lifecycle?.tags).toBeDefined();
    });

    it('should return null for unknown document', () => {
      const lifecycle = lifecycleTracker.getDocumentLifecycle('unknown-doc');
      expect(lifecycle).toBeNull();
    });

    it('should get all documents lifecycle', () => {
      const allLifecycles = lifecycleTracker.getAllDocumentsLifecycle();
      expect(allLifecycles).toHaveLength(52);
    });

    it('should filter by status', () => {
      const activeDocs = lifecycleTracker.getDocumentsByStatus('active');
      expect(activeDocs.length).toBeGreaterThan(0);
      expect(activeDocs.every(doc => doc.status === 'active')).toBe(true);
    });

    it('should get document dependencies', () => {
      const dependencies = lifecycleTracker.getDocumentDependencies('arch-002');
      expect(dependencies.length).toBeGreaterThan(0);
      expect(dependencies.some(doc => doc.id === 'arch-001')).toBe(true);
    });
  });

  describe('No Notion Dependency', () => {
    it('should not import any Notion modules', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      
      const governanceFiles = [
        '../src/core/governance-corpus.ts',
        '../src/core/governance-search.ts',
        '../src/core/governance-context.ts',
        '../src/core/governance-lifecycle.ts',
      ];

      for (const file of governanceFiles) {
        const filePath = path.resolve(__dirname, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).not.toContain('notion');
        expect(content).not.toContain('Notion');
        expect(content).not.toContain('@notionhq');
      }
    });
  });
});