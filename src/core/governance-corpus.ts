import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface GovernanceDocument {
  id: string;
  title: string;
  path: string;
  type: string;
  status: string;
  dependencies: string[];
  tags: string[];
  content?: string;
  wordCount?: number;
  linkCount?: number;
  lastModified?: Date;
}

export interface GovernanceCorpusMetadata {
  version: string;
  corpus: string;
  generated: string;
  totalDocuments: number;
  categories: string[];
}

export interface GovernanceCorpus {
  metadata: GovernanceCorpusMetadata;
  documents: GovernanceDocument[];
  rootPath: string;
}

export class GovernanceCorpusDiscovery {
  private readonly corpusRoot: string;
  private readonly indexPath: string;
  private corpus: GovernanceCorpus | null = null;

  constructor() {
    const homeDir = os.homedir();
    this.corpusRoot = path.join(homeDir, '.xurgo', 'governance', 'xurgo-ecosystem');
    this.indexPath = path.join(this.corpusRoot, 'atlas-index.json');
  }

  discover(): GovernanceCorpus | null {
    if (this.corpus) {
      return this.corpus;
    }

    if (!fs.existsSync(this.corpusRoot) || !fs.existsSync(this.indexPath)) {
      return null;
    }

    try {
      const indexContent = fs.readFileSync(this.indexPath, 'utf-8');
      const indexData = JSON.parse(indexContent);

      const documents: GovernanceDocument[] = [];
      for (const category of Object.keys(indexData.index)) {
        const categoryData = indexData.index[category];
        for (const doc of categoryData.documents) {
          const docPath = path.join(this.corpusRoot, doc.path.replace('governance/', ''));
          const exists = fs.existsSync(docPath);
          const lastModified = exists ? fs.statSync(docPath).mtime : undefined;

          let content: string | undefined;
          let wordCount: number | undefined;
          let linkCount: number | undefined;

          if (exists) {
            content = fs.readFileSync(docPath, 'utf-8');
            wordCount = content.split(/\s+/).length;
            linkCount = (content.match(/\[.*?\]\(.*?\)/g) || []).length;
          }

          documents.push({
            id: doc.id,
            title: doc.title,
            path: doc.path,
            type: doc.type,
            status: doc.status,
            dependencies: doc.dependencies,
            tags: doc.tags,
            content,
            wordCount,
            linkCount,
            lastModified,
          });
        }
      }

      this.corpus = {
        metadata: {
          version: indexData.version,
          corpus: indexData.corpus,
          generated: indexData.generated,
          totalDocuments: indexData.total_documents,
          categories: Object.keys(indexData.index),
        },
        documents,
        rootPath: this.corpusRoot,
      };

      return this.corpus;
    } catch (error) {
      console.error('Failed to discover governance corpus:', error);
      return null;
    }
  }

  getDocumentById(id: string): GovernanceDocument | null {
    const corpus = this.discover();
    if (!corpus) return null;

    return corpus.documents.find(doc => doc.id === id) || null;
  }

  getDocumentsByCategory(category: string): GovernanceDocument[] {
    const corpus = this.discover();
    if (!corpus) return [];

    const categoryMap: Record<string, string> = {
      'policies': 'policy',
      'architecture': 'architecture',
      'standards': 'standard',
      'products': 'product',
      'research': 'research',
      'templates': 'template',
    };

    const docType = categoryMap[category] || category;
    return corpus.documents.filter(doc => doc.type === docType);
  }

  searchDocuments(query: string): GovernanceDocument[] {
    const corpus = this.discover();
    if (!corpus) return [];

    const lowerQuery = query.toLowerCase();
    return corpus.documents.filter(doc =>
      doc.title.toLowerCase().includes(lowerQuery) ||
      doc.tags.some(tag => tag.toLowerCase().includes(lowerQuery)) ||
      doc.content?.toLowerCase().includes(lowerQuery)
    );
  }
}