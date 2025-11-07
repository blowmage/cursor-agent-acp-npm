/**
 * Content Processing Module
 *
 * Handles processing of different content types (text, code, image) for ACP protocol.
 * Manages content transformation between ACP format and Cursor CLI format.
 */

import type { ContentBlock } from '@agentclientprotocol/sdk';
import { ProtocolError, type Logger, type AdapterConfig } from '../types';

export interface ContentProcessorOptions {
  config: AdapterConfig;
  logger: Logger;
}

export interface ProcessedContent {
  value: string;
  metadata: Record<string, any>;
}

interface ContentMetadata {
  blocks: Array<{
    index: number;
    type: string;
    size: number;
    [key: string]: any;
  }>;
  totalSize: number;
}

interface StreamingState {
  inCodeBlock: boolean;
  codeLanguage?: string;
  accumulatedContent: string;
  pendingTextBlocks: string[];
}

export class ContentProcessor {
  private readonly logger: Logger;
  private streamingState: StreamingState | null = null;

  constructor(options: ContentProcessorOptions) {
    // this.config = options.config; // Not needed for current implementation
    this.logger = options.logger;
  }

  /**
   * Process content blocks for sending to Cursor CLI
   */
  async processContent(blocks: ContentBlock[]): Promise<ProcessedContent> {
    this.logger.debug('Processing content blocks', { count: blocks.length });

    const processedBlocks: string[] = [];
    const metadata: ContentMetadata = {
      blocks: [],
      totalSize: 0,
    };

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (!block) {
        continue;
      }

      const processedBlock = await this.processContentBlock(block, i);
      processedBlocks.push(processedBlock.value);

      metadata.blocks.push({
        index: i,
        type: block.type,
        size: processedBlock.value.length,
        ...processedBlock.metadata,
      });

      metadata.totalSize += processedBlock.value.length;
    }

    const result = {
      value: processedBlocks.join('\n\n'),
      metadata,
    };

    this.logger.debug('Content processing completed', {
      totalBlocks: blocks.length,
      totalSize: metadata.totalSize,
    });

    return result;
  }

  /**
   * Process individual content block
   */
  private async processContentBlock(
    block: ContentBlock,
    index: number
  ): Promise<ProcessedContent> {
    switch (block.type) {
      case 'text':
        return this.processTextBlock(block, index);
      case 'image':
        return this.processImageBlock(block, index);
      case 'audio':
        return this.processAudioBlock(block, index);
      case 'resource':
        return this.processResourceBlock(block, index);
      case 'resource_link':
        return this.processResourceLinkBlock(block, index);
      default:
        // TypeScript knows this should be unreachable, but at runtime invalid blocks might arrive
        throw new ProtocolError(
          `Unknown content block type: ${(block as any)?.type || 'unknown'}`
        );
    }
  }

  /**
   * Process text content block
   * Per ACP spec: uses 'text' field
   */
  private async processTextBlock(
    block: Extract<ContentBlock, { type: 'text' }>,
    index: number
  ): Promise<ProcessedContent> {
    const textContent = block.text;

    this.logger.debug('Processing text block', {
      index,
      length: textContent.length,
      hasAnnotations: Boolean(block.annotations),
    });

    // Basic text sanitization and formatting
    const value = this.sanitizeText(textContent);

    return {
      value,
      metadata: {
        originalLength: textContent.length,
        sanitized: value !== textContent,
        annotations: block.annotations,
      },
    };
  }

  /**
   * Process image content block
   * Per ACP spec: uses 'data' field
   */
  private async processImageBlock(
    block: Extract<ContentBlock, { type: 'image' }>,
    index: number
  ): Promise<ProcessedContent> {
    const imageData = block.data;

    this.logger.debug('Processing image block', {
      index,
      mimeType: block.mimeType,
      dataLength: imageData.length,
      uri: block.uri,
      hasAnnotations: Boolean(block.annotations),
    });

    // Validate image data
    if (!this.isValidBase64(imageData)) {
      throw new ProtocolError(`Invalid base64 image data in block ${index}`);
    }

    // Format image reference for Cursor CLI
    let value = '';

    if (block.uri) {
      value += `# Image: ${block.uri}\n`;
    } else {
      value += `# Image (${block.mimeType})\n`;
    }

    value += `[Image data: ${block.mimeType}, ${this.formatDataSize(imageData.length)} base64]`;

    // Note: In a real implementation, you might want to:
    // 1. Save the image to a temporary file
    // 2. Convert to a format Cursor CLI can understand
    // 3. Include image analysis/description if supported

    return {
      value,
      metadata: {
        mimeType: block.mimeType,
        uri: block.uri,
        dataSize: imageData.length,
        isValidBase64: true,
        annotations: block.annotations,
      },
    };
  }

  /**
   * Process audio content block
   * Per ACP spec: Audio data for transcription or analysis
   */
  private async processAudioBlock(
    block: Extract<ContentBlock, { type: 'audio' }>,
    index: number
  ): Promise<ProcessedContent> {
    this.logger.debug('Processing audio block', {
      index,
      mimeType: block.mimeType,
      dataLength: block.data.length,
      hasAnnotations: Boolean(block.annotations),
    });

    // Validate audio data
    if (!this.isValidBase64(block.data)) {
      throw new ProtocolError(`Invalid base64 audio data in block ${index}`);
    }

    const dataSize = this.formatDataSize(block.data.length);
    const audioFormat = block.mimeType.split('/')[1] || 'unknown';

    const value = `[Audio: ${block.mimeType}, ${dataSize}, format: ${audioFormat}]`;

    return {
      value,
      metadata: {
        mimeType: block.mimeType,
        dataSize: block.data.length,
        format: audioFormat,
        isValidBase64: true,
        annotations: block.annotations,
      },
    };
  }

  /**
   * Process embedded resource content block
   * Per ACP spec: Preferred way to include context (e.g., file contents)
   */
  private async processResourceBlock(
    block: Extract<ContentBlock, { type: 'resource' }>,
    index: number
  ): Promise<ProcessedContent> {
    const { uri, mimeType } = block.resource;
    const isText = 'text' in block.resource;

    this.logger.debug('Processing resource block', {
      index,
      uri,
      mimeType,
      isText,
      hasAnnotations: Boolean(block.annotations),
    });

    let value = '';
    let size = 0;

    value += `# Resource: ${uri}\n`;
    if (mimeType) {
      value += `# Type: ${mimeType}\n`;
    }
    value += '\n';

    if (isText && 'text' in block.resource) {
      value += block.resource.text;
      size = block.resource.text.length;
    } else if ('blob' in block.resource) {
      const blobSize = this.formatDataSize(block.resource.blob.length);
      value += `[Binary data: ${blobSize}]`;
      size = block.resource.blob.length;
    }

    return {
      value,
      metadata: {
        uri,
        mimeType,
        isText,
        size,
        annotations: block.annotations,
      },
    };
  }

  /**
   * Process resource link content block
   * Per ACP spec: Reference to agent-accessible resources
   */
  private async processResourceLinkBlock(
    block: Extract<ContentBlock, { type: 'resource_link' }>,
    index: number
  ): Promise<ProcessedContent> {
    this.logger.debug('Processing resource link block', {
      index,
      uri: block.uri,
      name: block.name,
      hasAnnotations: Boolean(block.annotations),
    });

    let value = '';
    value += `# Resource Link: ${block.name}\n`;
    value += `URI: ${block.uri}\n`;

    if (block.title) {
      value += `Title: ${block.title}\n`;
    }
    if (block.description) {
      value += `Description: ${block.description}\n`;
    }
    if (block.mimeType) {
      value += `Type: ${block.mimeType}\n`;
    }
    if (block.size !== undefined && block.size !== null) {
      value += `Size: ${this.formatDataSize(block.size)}\n`;
    }

    return {
      value,
      metadata: {
        uri: block.uri ?? undefined,
        name: block.name,
        mimeType: block.mimeType,
        title: block.title,
        description: block.description,
        size: block.size,
        annotations: block.annotations,
      },
    };
  }

  /**
   * Parse response from Cursor CLI back to content blocks
   */
  async parseResponse(response: string): Promise<ContentBlock[]> {
    this.logger.debug('Parsing Cursor CLI response', {
      length: response.length,
    });

    const blocks: ContentBlock[] = [];

    // Split response into logical sections
    const sections = this.splitResponseSections(response);

    for (const section of sections) {
      const block = await this.parseResponseSection(section);
      if (block) {
        blocks.push(block);
      }
    }

    // Post-process to combine file headers with following code blocks
    const processedBlocks = this.postProcessBlocks(blocks);

    this.logger.debug('Response parsing completed', {
      blocks: processedBlocks.length,
    });

    return processedBlocks;
  }

  /**
   * Start a new streaming session
   * Call this before processing streaming chunks
   */
  startStreaming(): void {
    this.streamingState = {
      inCodeBlock: false,
      accumulatedContent: '',
      pendingTextBlocks: [],
    };
    this.logger.debug('Started streaming session');
  }

  /**
   * Reset streaming state
   * Call this after streaming is complete or to reset state
   */
  resetStreaming(): void {
    this.streamingState = null;
    this.logger.debug('Reset streaming session');
  }

  /**
   * Finalize streaming and return any remaining partial content
   * Call this at the end of streaming to flush any buffered content
   */
  finalizeStreaming(): ContentBlock | null {
    if (!this.streamingState) {
      return null;
    }

    const state = this.streamingState;
    let result: ContentBlock | null = null;

    // If we're in a code block but it wasn't closed, treat remaining as code
    if (state.inCodeBlock && state.accumulatedContent.trim()) {
      const language = state.codeLanguage || '';
      result = {
        type: 'text',
        text: `\`\`\`${language}\n${state.accumulatedContent}\n\`\`\``,
      };
    } else if (state.accumulatedContent.trim()) {
      // Flush any remaining text
      result = {
        type: 'text',
        text: state.accumulatedContent,
      };
    }

    this.resetStreaming();
    return result;
  }

  /**
   * Process streaming chunk with stateful handling of partial code blocks
   * Handles cases where code blocks arrive across multiple chunks
   */
  async processStreamChunk(chunkData: any): Promise<ContentBlock | null> {
    if (!chunkData || typeof chunkData !== 'string') {
      return null;
    }

    // Initialize streaming state if not already initialized
    if (!this.streamingState) {
      this.startStreaming();
    }

    const state = this.streamingState;
    if (!state) {
      // This should never happen after startStreaming(), but TypeScript needs this check
      return null;
    }

    state.accumulatedContent += chunkData;

    // Check for code block markers in accumulated content
    const accumulated = state.accumulatedContent;
    const codeBlockStartRegex = /```(\w+)?\n?/g;

    // Look for code block start
    if (!state.inCodeBlock) {
      const startMatch = codeBlockStartRegex.exec(accumulated);
      if (startMatch) {
        // Found start of code block
        const beforeCode = accumulated.substring(0, startMatch.index);
        const language = startMatch[1]?.trim();

        // If there's content before the code block, return it as text first
        if (beforeCode.trim()) {
          // Extract any complete text blocks before this code block
          const textToReturn = beforeCode.trim();
          // Remove the opening marker and keep only the code content
          state.accumulatedContent = accumulated.substring(
            startMatch.index + startMatch[0].length
          );
          state.inCodeBlock = true;
          if (language) {
            state.codeLanguage = language;
          } else {
            delete state.codeLanguage;
          }

          // Return text block - code block will be processed on next chunk
          return {
            type: 'text',
            text: textToReturn,
          };
        } else {
          // Code block starts at beginning
          state.inCodeBlock = true;
          if (language) {
            state.codeLanguage = language;
          } else {
            delete state.codeLanguage;
          }
          // Remove the opening marker from accumulated content
          state.accumulatedContent = accumulated.substring(
            startMatch.index + startMatch[0].length
          );
          // Don't return anything yet - wait for code content
          return null;
        }
      } else {
        // No code block detected yet, check if we have enough content to return as text
        // For text blocks, we can return incrementally
        // But check if we might be starting a code block (partial ```)
        if (accumulated.includes('```')) {
          // Might be a partial code block marker, wait for more data
          return null;
        }

        // Check for image references
        if (accumulated.includes('[Image data:')) {
          const imageMatch = accumulated.match(/\[Image data:[^\]]+\]/);
          if (imageMatch) {
            const imageIndex = accumulated.indexOf(imageMatch[0]);
            const beforeImage = accumulated.substring(0, imageIndex).trim();
            const imageText = imageMatch[0];
            state.accumulatedContent = accumulated.substring(
              imageIndex + imageText.length
            );

            // Return text block before image if any
            if (beforeImage) {
              return {
                type: 'text',
                text: beforeImage,
              };
            }

            // Return image reference
            return {
              type: 'text',
              text: imageText,
            };
          }
        }

        // Return text block if we have substantial content or see a newline
        // This allows incremental text streaming
        if (
          accumulated.length > 0 &&
          (accumulated.includes('\n') || accumulated.length > 100)
        ) {
          // Find last complete line
          const lastNewline = accumulated.lastIndexOf('\n');
          if (lastNewline > 0) {
            const textToReturn = accumulated.substring(0, lastNewline + 1);
            state.accumulatedContent = accumulated.substring(lastNewline + 1);
            return {
              type: 'text',
              text: textToReturn,
            };
          }
        }

        // Not enough content yet, wait for more
        return null;
      }
    }

    // We're in a code block, look for closing marker
    if (state.inCodeBlock) {
      // Look for closing ``` marker
      // It should be on its own line or at the end
      const closingIndex = accumulated.indexOf('```');

      if (closingIndex >= 0) {
        // Check if this is a proper closing marker
        // It should be preceded by newline or be at start, and followed by newline/end/whitespace
        const beforeMarker =
          closingIndex > 0 ? accumulated[closingIndex - 1] : '';
        const afterMarkerStart = closingIndex + 3;
        const afterMarker =
          afterMarkerStart < accumulated.length
            ? accumulated.substring(afterMarkerStart, afterMarkerStart + 1)
            : '';

        // Valid closing marker if:
        // 1. At start of accumulated (rare but possible)
        // 2. Preceded by newline
        // 3. Followed by newline, end of string, or whitespace
        const isValidClosing =
          closingIndex === 0 ||
          (beforeMarker === '\n' &&
            (afterMarker === '' ||
              afterMarker === '\n' ||
              /\s/.test(afterMarker)));

        if (isValidClosing) {
          const codeContent = accumulated.substring(0, closingIndex).trim();
          const afterCode = accumulated.substring(closingIndex + 3).trimStart();

          if (codeContent.length > 0 || closingIndex > 0) {
            // Complete code block found - convert to text with code formatting
            const language = state.codeLanguage || '';
            const result: ContentBlock = {
              type: 'text',
              text: `\`\`\`${language}\n${codeContent}\n\`\`\``,
            };

            // Reset state - remaining content will be processed in next chunk
            state.inCodeBlock = false;
            delete state.codeLanguage;
            state.accumulatedContent = afterCode;

            // If there's content after the code block, try to process it
            // But don't recurse - let the next chunk handle it
            return result;
          }
        }
      }

      // No valid closing marker found yet, accumulate and wait
      return null;
    }

    // Fallback: return accumulated content as text if substantial
    if (accumulated.length > 100) {
      const textToReturn = accumulated;
      state.accumulatedContent = '';
      return {
        type: 'text',
        text: textToReturn,
      };
    }

    return null;
  }

  /**
   * Split response into logical sections
   */
  private splitResponseSections(response: string): string[] {
    const sections: string[] = [];
    const lines = response.split('\n');
    let currentSection: string[] = [];
    let inCodeBlock = false;

    for (const line of lines) {
      if (line.trim().startsWith('```')) {
        if (inCodeBlock) {
          // End of code block
          currentSection.push(line);
          sections.push(currentSection.join('\n'));
          currentSection = [];
          inCodeBlock = false;
        } else {
          // Start of code block
          if (currentSection.length > 0) {
            sections.push(currentSection.join('\n'));
            currentSection = [];
          }
          currentSection.push(line);
          inCodeBlock = true;
        }
      } else if (
        line.trim().startsWith('# File:') ||
        line.trim().startsWith('# Image:')
      ) {
        // Start of new section
        if (currentSection.length > 0) {
          sections.push(currentSection.join('\n'));
          currentSection = [];
        }
        currentSection.push(line);
      } else {
        currentSection.push(line);
      }
    }

    if (currentSection.length > 0) {
      sections.push(currentSection.join('\n'));
    }

    return sections.filter((section) => section.trim().length > 0);
  }

  /**
   * Parse individual response section
   */
  private async parseResponseSection(
    section: string
  ): Promise<ContentBlock | null> {
    const trimmed = section.trim();

    if (trimmed.startsWith('```')) {
      return this.parseCodeSection(trimmed);
    } else if (trimmed.startsWith('# File:')) {
      return this.parseFileSection(trimmed);
    } else if (trimmed.startsWith('# Image:')) {
      return this.parseImageSection(trimmed);
    }
    return {
      type: 'text',
      text: trimmed,
    };
  }

  /**
   * Parse code section - returns as text with code formatting
   */
  private parseCodeSection(section: string): ContentBlock {
    // Return the code section as-is (already formatted with ```)
    return {
      type: 'text',
      text: section,
    };
  }

  /**
   * Parse file section
   */
  private parseFileSection(section: string): ContentBlock {
    // Return file section as text (SDK ContentBlock doesn't support custom fields)
    return {
      type: 'text',
      text: section,
    };
  }

  /**
   * Parse image section
   */
  private parseImageSection(
    section: string
  ): Extract<ContentBlock, { type: 'text' }> {
    // For now, treat image sections as text descriptions
    // In a real implementation, you might extract base64 data
    return {
      type: 'text',
      text: section,
    };
  }

  /**
   * Sanitize text content
   */
  private sanitizeText(text: string): string {
    // Basic sanitization - remove null bytes, normalize line endings
    return text.replace(/\0/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  /**
   * Validate base64 string
   */
  private isValidBase64(str: string): boolean {
    try {
      return Buffer.from(str, 'base64').toString('base64') === str;
    } catch {
      return false;
    }
  }

  /**
   * Format data size for display
   */
  private formatDataSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)}${units[unitIndex]}`;
  }

  /**
   * Get content statistics
   */
  getContentStats(blocks: ContentBlock[]): Record<string, any> {
    const stats = {
      total: blocks.length,
      byType: {} as Record<string, number>,
      totalSize: 0,
    };

    for (const block of blocks) {
      const type = block.type;
      stats.byType[type] = (stats.byType[type] || 0) + 1;

      switch (block.type) {
        case 'text':
          stats.totalSize += block.text.length;
          break;
        case 'image':
          stats.totalSize += block.data.length;
          break;
        case 'audio':
          stats.totalSize += block.data.length;
          break;
        case 'resource':
          stats.totalSize +=
            'text' in block.resource
              ? block.resource.text.length
              : block.resource.blob.length;
          break;
        case 'resource_link':
          stats.totalSize += block.uri.length;
          break;
      }
    }

    return stats;
  }

  /**
   * Validate content blocks
   */
  validateContentBlocks(blocks: ContentBlock[]): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (!Array.isArray(blocks)) {
      errors.push('Content blocks must be an array');
      return { valid: false, errors };
    }

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const blockErrors = this.validateContentBlock(block, i);
      errors.push(...blockErrors);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate individual content block
   * Per ACP SDK: Only text, image, audio, resource, resource_link are valid
   * Note: diff and terminal are ToolCallContent types, NOT ContentBlock types
   */
  private validateContentBlock(block: any, index: number): string[] {
    const errors: string[] = [];

    if (!block || typeof block !== 'object') {
      errors.push(`Block ${index}: must be an object`);
      return errors;
    }

    if (!block.type || typeof block.type !== 'string') {
      errors.push(`Block ${index}: type is required and must be a string`);
      return errors;
    }

    switch (block.type) {
      case 'text':
        // Per ACP spec: text content uses 'text' field
        if (typeof block.text !== 'string') {
          errors.push(
            `Block ${index}: text content must be a string (use 'text' field)`
          );
        }
        break;
      case 'image': {
        // Per ACP spec: image content uses 'data' field
        if (typeof block.data !== 'string') {
          errors.push(
            `Block ${index}: data must be a string (use 'data' field)`
          );
        } else if (!this.isValidBase64(block.data)) {
          errors.push(`Block ${index}: data must be valid base64`);
        }
        if (typeof block.mimeType !== 'string') {
          errors.push(
            `Block ${index}: mimeType is required and must be a string`
          );
        }
        // Validate optional uri field
        if (
          block.uri !== undefined &&
          block.uri !== null &&
          typeof block.uri !== 'string'
        ) {
          errors.push(`Block ${index}: uri must be a string or null`);
        }
        break;
      }
      case 'audio':
        // Per ACP spec: audio content
        if (typeof block.data !== 'string') {
          errors.push(`Block ${index}: data must be a string`);
        } else if (!this.isValidBase64(block.data)) {
          errors.push(`Block ${index}: data must be valid base64`);
        }
        if (typeof block.mimeType !== 'string') {
          errors.push(
            `Block ${index}: mimeType is required and must be a string`
          );
        }
        break;
      case 'resource':
        // Per ACP spec: embedded resource
        if (!block.resource || typeof block.resource !== 'object') {
          errors.push(`Block ${index}: resource field is required`);
        } else {
          if (typeof block.resource.uri !== 'string') {
            errors.push(
              `Block ${index}: resource.uri is required and must be a string`
            );
          }
          const hasText = typeof block.resource.text === 'string';
          const hasBlob = typeof block.resource.blob === 'string';
          if (!hasText && !hasBlob) {
            errors.push(
              `Block ${index}: resource must have either text or blob field`
            );
          }
          // Validate optional mimeType
          if (
            block.resource.mimeType !== undefined &&
            block.resource.mimeType !== null &&
            typeof block.resource.mimeType !== 'string'
          ) {
            errors.push(
              `Block ${index}: resource.mimeType must be a string or null`
            );
          }
          // Validate base64 blob
          if (hasBlob && !this.isValidBase64(block.resource.blob)) {
            errors.push(`Block ${index}: resource.blob must be valid base64`);
          }
        }
        break;
      case 'resource_link':
        // Per ACP spec: resource link
        if (typeof block.uri !== 'string') {
          errors.push(`Block ${index}: uri is required and must be a string`);
        }
        if (typeof block.name !== 'string') {
          errors.push(`Block ${index}: name is required and must be a string`);
        }
        // Validate optional fields
        if (
          block.title !== undefined &&
          block.title !== null &&
          typeof block.title !== 'string'
        ) {
          errors.push(`Block ${index}: title must be a string or null`);
        }
        if (
          block.description !== undefined &&
          block.description !== null &&
          typeof block.description !== 'string'
        ) {
          errors.push(`Block ${index}: description must be a string or null`);
        }
        if (
          block.mimeType !== undefined &&
          block.mimeType !== null &&
          typeof block.mimeType !== 'string'
        ) {
          errors.push(`Block ${index}: mimeType must be a string or null`);
        }
        if (
          block.size !== undefined &&
          block.size !== null &&
          typeof block.size !== 'number'
        ) {
          errors.push(`Block ${index}: size must be a number or null`);
        }
        break;
      default:
        errors.push(
          `Block ${index}: unknown content type '${block.type}' (valid types: text, image, audio, resource, resource_link)`
        );
    }

    // Validate annotations if present
    if (block.annotations) {
      errors.push(...this.validateAnnotations(block.annotations, index));
    }

    return errors;
  }

  /**
   * Validate annotations on content blocks
   * Per ACP SDK: Annotations have audience, priority, lastModified
   */
  private validateAnnotations(annotations: any, index: number): string[] {
    const errors: string[] = [];

    if (!annotations || typeof annotations !== 'object') {
      return errors; // null/undefined is valid
    }

    // Validate audience (must be array of 'user' or 'assistant')
    if (annotations.audience !== undefined && annotations.audience !== null) {
      if (!Array.isArray(annotations.audience)) {
        errors.push(
          `Block ${index}: annotations.audience must be an array or null`
        );
      } else {
        for (const role of annotations.audience) {
          if (role !== 'user' && role !== 'assistant') {
            errors.push(
              `Block ${index}: annotations.audience must contain only 'user' or 'assistant'`
            );
            break;
          }
        }
      }
    }

    // Validate lastModified (ISO 8601 timestamp)
    if (
      annotations.lastModified !== undefined &&
      annotations.lastModified !== null
    ) {
      if (typeof annotations.lastModified !== 'string') {
        errors.push(
          `Block ${index}: annotations.lastModified must be a string or null`
        );
      } else if (isNaN(Date.parse(annotations.lastModified))) {
        errors.push(
          `Block ${index}: annotations.lastModified must be a valid ISO 8601 timestamp`
        );
      }
    }

    // Validate priority (must be non-negative number)
    if (annotations.priority !== undefined && annotations.priority !== null) {
      if (typeof annotations.priority !== 'number') {
        errors.push(
          `Block ${index}: annotations.priority must be a number or null`
        );
      } else if (annotations.priority < 0) {
        errors.push(
          `Block ${index}: annotations.priority must be non-negative`
        );
      }
    }

    return errors;
  }

  /**
   * Post-process blocks to combine file headers with following code blocks
   */
  private postProcessBlocks(blocks: ContentBlock[]): ContentBlock[] {
    const processedBlocks: ContentBlock[] = [];

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];

      // Check if this is a text block that looks like a file header
      if (block) {
        processedBlocks.push(block);
      }
    }

    return processedBlocks;
  }
}
