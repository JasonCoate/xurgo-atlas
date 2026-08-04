import { GovernanceCorpusDiscovery, GovernanceDocument } from './governance-corpus.js';

export interface GovernanceDocumentLifecycle {
  id: string;
  title: string;
  type: string;
  status: string;
  dependencies: string[];
  tags: string[];
  lastModified: Date | undefined;
  wordCount: number | undefined;
  linkCount: number | undefined;
}

export class GovernanceLifecycleTracker {
  private readonly corpusDiscovery: GovernanceCorpusDiscovery;

  constructor() {
    this.corpusDiscovery = new GovernanceCorpusDiscovery();
  }

  getDocumentLifecycle(documentId: string): GovernanceDocumentLifecycle | null {
    const doc = this.corpusDiscovery.getDocumentById(documentId);
    if (!doc) return null;

    return {
      id: doc.id,
      title: doc.title,
      type: doc.type,
      status: doc.status,
      dependencies: doc.dependencies,
      tags: doc.tags,
      lastModified: doc.lastModified,
      wordCount: doc.wordCount,
      linkCount: doc.linkCount,
    };
  }

  getAllDocumentsLifecycle(): GovernanceDocumentLifecycle[] {
    const corpus = this.corpusDiscovery.discover();
    if (!corpus) return [];

    return corpus.documents.map(doc => ({
      id: doc.id,
      title: doc.title,
      type: doc.type,
      status: doc.status,
      dependencies: doc.dependencies,
      tags: doc.tags,
      lastModified: doc.lastModified,
      wordCount: doc.wordCount,
      linkCount: doc.linkCount,
    }));
  }

  getDocumentsByStatus(status: string): GovernanceDocumentLifecycle[] {
    return this.getAllDocumentsLifecycle().filter(doc => doc.status === status);
  }

  getDocumentDependencies(documentId: string): GovernanceDocumentLifecycle[] {
    const doc = this.corpusDiscovery.getDocumentById(documentId);
    if (!doc) return [];

    return doc.dependencies
      .map(depId => this.corpusDiscovery.getDocumentById(depId))
      .filter((dep): dep is GovernanceDocument => dep !== null)
      .map(dep => ({
        id: dep.id,
        title: dep.title,
        type: dep.type,
        status: dep.status,
        dependencies: dep.dependencies,
        tags: dep.tags,
        lastModified: dep.lastModified,
        wordCount: dep.wordCount,
        linkCount: dep.linkCount,
      }));
  }
}