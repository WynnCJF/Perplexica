import * as schema from './schema';
import { eq, and, gt } from 'drizzle-orm';

/**
 * In-memory mock implementation of the database
 * This implementation provides the same API as the real database
 * but doesn't actually persist data to disk
 */
class MockDb {
  private chats: Map<string, any> = new Map();
  private messages: Map<string, any[]> = new Map();
  private messageIdCounter: number = 1;

  // Create a query builder that mimics drizzle's API
  query = {
    chats: {
      findMany: async () => {
        return Array.from(this.chats.values());
      },
      findFirst: async ({ where }: any) => {
        // Handle eq operation for chat id
        if (where?._type === 'eq' && where._ref?.name === 'id') {
          return this.chats.get(where._value) || null;
        }
        return null;
      }
    },
    messages: {
      findMany: async ({ where }: any = {}) => {
        // Handle eq operation for chatId
        if (where?._type === 'eq' && where._ref?.name === 'chatId') {
          return this.messages.get(where._value) || [];
        }
        return Array.from(this.messages.values()).flat();
      },
      findFirst: async ({ where }: any) => {
        // Handle eq operation for messageId
        if (where?._type === 'eq' && where._ref?.name === 'messageId') {
          const messageId = where._value;
          for (const messagesArray of this.messages.values()) {
            const message = messagesArray.find(m => m.messageId === messageId);
            if (message) return message;
          }
        }
        return null;
      }
    }
  };

  // Insert implementation
  insert = (table: any) => {
    return {
      values: (data: any) => {
        return {
          execute: async () => {
            if (table === schema.chats) {
              this.chats.set(data.id, data);
              this.messages.set(data.id, []);
            } else if (table === schema.messages) {
              const messagesArray = this.messages.get(data.chatId) || [];
              const newMessage = {
                ...data,
                id: this.messageIdCounter++
              };
              messagesArray.push(newMessage);
              this.messages.set(data.chatId, messagesArray);
            }
            return { rowsAffected: 1 };
          }
        };
      }
    };
  };

  // Delete implementation
  delete = (table: any) => {
    return {
      where: (condition: any) => {
        return {
          execute: async () => {
            // Handle eq condition
            if (condition?._type === 'eq') {
              const field = condition._ref?.name;
              const value = condition._value;
              
              if (field === 'id' && table === schema.chats) {
                // Delete chat by id
                this.chats.delete(value);
                this.messages.delete(value);
              } else if (field === 'chatId' && table === schema.messages) {
                // Delete all messages for a chat
                this.messages.delete(value);
              }
            } 
            // Handle 'and' condition specifically for the message truncation case
            else if (condition?._type === 'and') {
              const [gtCondition, eqCondition] = condition.conditions;
              
              if (gtCondition?._type === 'gt' && eqCondition?._type === 'eq') {
                const messageId = gtCondition._ref?.name === 'id' ? gtCondition._value : null;
                const chatId = eqCondition._ref?.name === 'chatId' ? eqCondition._value : null;
                
                if (messageId && chatId) {
                  const messagesArray = this.messages.get(chatId) || [];
                  // Keep messages with id <= messageId
                  this.messages.set(
                    chatId,
                    messagesArray.filter(m => m.id <= messageId)
                  );
                }
              }
            }
            
            return { rowsAffected: 1 };
          }
        };
      }
    };
  };

  // For debugging
  _dump() {
    return {
      chats: Object.fromEntries(this.chats),
      messages: Object.fromEntries(this.messages)
    };
  }
}

console.log('Using in-memory mock database - NO DATA WILL BE PERSISTED');
console.log('This implementation is for demo purposes only - chat history will be lost on server restart');
const db = new MockDb();

export default db;
