import * as restate from '@restatedev/restate-sdk';
import {
  AnswerRequest,
  AnswerResponse,
  CollectionView,
  CollectionsResponse,
  DocumentResponse,
  DocumentsResponse,
  GetCollectionRequest,
  GetDocumentRequest,
  ListCollectionsRequest,
  ListDocumentsRequest,
  SearchRequest,
  SearchResponse,
} from './schemas.js';

/**
 * The Restate binding: six handlers on one public service. core-api's RAG routes call them through
 * the Restate ingress. No other unit calls this service, so the schemas stay in this unit; if one
 * ever does, move them into `packages/contract-rag-query` and import them from both sides.
 */
export const ragQueryApi = restate.iface.service(
  'RagQuery',
  {
    search: restate.iface.schemas({
      input: SearchRequest,
      output: SearchResponse,
      description: 'Semantic search over one collection, optionally reranked by a model',
    }),
    answer: restate.iface.schemas({
      input: AnswerRequest,
      output: AnswerResponse,
      description: 'Answers a question from retrieved chunks, with checked [S#] citations',
    }),
    listCollections: restate.iface.schemas({
      input: ListCollectionsRequest,
      output: CollectionsResponse,
      description: 'Lists the collections, with document and chunk counts',
    }),
    getCollection: restate.iface.schemas({
      input: GetCollectionRequest,
      output: CollectionView,
      description: "Describes one collection: its settings and what's in it",
    }),
    listDocuments: restate.iface.schemas({
      input: ListDocumentsRequest,
      output: DocumentsResponse,
      description: "Pages through a collection's documents in id order",
    }),
    getDocument: restate.iface.schemas({
      input: GetDocumentRequest,
      output: DocumentResponse,
      description: 'Describes one document, and optionally returns its chunks',
    }),
  },
  {
    description:
      'Searches RAG collections and answers questions from them with cited sources (public; called by core-api)',
  },
);
