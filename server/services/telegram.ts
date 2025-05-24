import TelegramBot from 'node-telegram-bot-api';
import { storage } from '../storage';
import {
  ActiveConversation,
  DefaultResponseFormatter,
  AIService,
  ConversationFlow, // For state persistence typing
  AIAnalysisResult // For understanding potential structured returns
} from './conversation-manager.refactored'; // Adjust path as needed
import { OpenAIServiceImpl } from './openai.refactored'; // Adjust path as needed
import { getAvailableTimeSlots, AvailabilitySlot } from './availability.service'; // Adjust path as needed
import { createTelegramReservation } from './telegram-booking'; // For the actual booking step
// import { CacheInvalidation } from '../cache'; // If/when cache is involved with bookings

// Store active bots by restaurant ID
const activeBots = new Map<number, TelegramBot>();
// Store active conversation instances by chat ID
const activeBotConversations = new Map<number, ActiveConversation>();

// Initialize shared services
// These can be singletons if their state is managed appropriately or if they are stateless.
const aiService: AIService = new OpenAIServiceImpl();
const responseFormatter = new DefaultResponseFormatter();

// --- Conversation Persistence (Placeholder Functions) ---
// In a real application, these would interact with a database or Redis.
async function loadConversationState(chatId: number, restaurantId: number): Promise<Partial<ConversationFlow> | undefined> {
  console.log(`[Telegram] STUB: Attempting to load conversation state for chatId ${chatId}, restaurant ${restaurantId}`);
  // Example: return await db.get(`conversation:${chatId}:${restaurantId}`);
  return undefined; // Always starts fresh in this stub
}

async function saveConversationState(chatId: number, restaurantId: number, flow: ConversationFlow): Promise<void> {
  console.log(`[Telegram] STUB: Saving conversation state for chatId ${chatId}, restaurant ${restaurantId}:`, flow.stage, flow.collectedInfo);
  // Example: await db.set(`conversation:${chatId}:${restaurantId}`, flow, { TTL: 3600 }); // Save with TTL
}

async function deleteConversationState(chatId: number, restaurantId: number): Promise<void> {
  console.log(`[Telegram] STUB: Deleting conversation state for chatId ${chatId}, restaurant ${restaurantId}`);
  // Example: await db.delete(`conversation:${chatId}:${restaurantId}`);
}
// --- End of Persistence Placeholders ---


// Helper to get or create an ActiveConversation instance
async function getOrCreateConversation(chatId: number, restaurantId: number, initialMessage?: string): Promise<ActiveConversation> {
  let conversation = activeBotConversations.get(chatId);
  if (!conversation) {
    const persistedFlow = await loadConversationState(chatId, restaurantId);
    const initialHistory = initialMessage ? [initialMessage] : [];

    console.log(`[Telegram] Creating new ActiveConversation for chatId: ${chatId}, restaurantId: ${restaurantId}`);
    conversation = new ActiveConversation(
        aiService,
        responseFormatter,
        initialHistory,
        persistedFlow
    );
    activeBotConversations.set(chatId, conversation);
  } else {
    // If conversation exists, ensure its history is updated if initialMessage is part of this context
    // Note: ActiveConversation.handleMessage already adds to history. This is for the very first message if instance exists.
    if (initialMessage && !conversation.getConversationFlow().conversationHistory.includes(initialMessage)) {
        // This scenario should be rare if getOrCreateConversation is called before handleMessage
        // For simplicity, we assume handleMessage is the primary way history is augmented.
    }
  }
  return conversation;
}

// Cleanup for in-memory map (a more robust solution needed for production with persistence)
setInterval(() => {
  // This is a naive cleanup for the in-memory map.
  // If using a proper persistent store with TTLs, this might not be needed for the map itself,
  // or it would only clear very old, non-active instances from memory.
  console.log(`[Telegram] Current in-memory active conversations: ${activeBotConversations.size}`);
  // A more robust cleanup would check last interaction time if instances are kept in memory long-term.
}, 3600000 * 3); // Every 3 hours log size


export async function setupTelegramBot(token: string, restaurantId: number): Promise<TelegramBot> {
  console.log(`[Telegram] 🚀 Setting up Telegram bot for restaurant ${restaurantId}`);

  if (activeBots.has(restaurantId)) {
    console.log(`[Telegram] 🛑 Stopping existing bot for restaurant ${restaurantId}`);
    const existingBot = activeBots.get(restaurantId);
    try {
      if (existingBot?.isPolling()) { // Check if polling before trying to stop
        await existingBot.stopPolling({ cancel: true });
      }
    } catch (error) {
        console.warn(`[Telegram] Error stopping existing bot (may have already been stopped):`, error)
    }
    activeBots.delete(restaurantId);
  }

  const bot = new TelegramBot(token, { polling: true });
  activeBots.set(restaurantId, bot);
  console.log(`[Telegram] ✅ Bot created and listening for restaurant ${restaurantId}`);

  const restaurant = await storage.getRestaurant(restaurantId);
  if (!restaurant) {
    console.error(`[Telegram] Restaurant with ID ${restaurantId} not found. Bot cannot function correctly.`);
    await bot.stopPolling(); // Stop the bot if essential data is missing
    activeBots.delete(restaurantId);
    throw new Error(`[Telegram] Restaurant with ID ${restaurantId} not found during bot setup.`);
  }

  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`[Telegram] /start command received from chatId: ${chatId} for restaurant ${restaurantId}`);
    // Reset conversation state for /start
    activeBotConversations.delete(chatId);
    await deleteConversationState(chatId, restaurantId); // Also clear any persisted state

    const conversation = await getOrCreateConversation(chatId, restaurantId, msg.text || "/start");

    const hour = new Date().getHours();
    let greeting = "Hello";
    if (hour < 12) greeting = "Good morning";
    else if (hour < 17) greeting = "Good afternoon";
    else greeting = "Good evening";

    // The welcome message can be static or generated via ResponseFormatter for consistency
    const welcomeMessage = `${greeting}! Welcome to ${restaurant.name}'s reservation assistant! 😊\n\nI can help you with:\n• Making a new reservation\n• Answering questions about the restaurant\n\nHow can I help you today?`;
    bot.sendMessage(chatId, welcomeMessage);

    // Optionally, you might want ActiveConversation to process the "/start" as an initial prompt
    // const initialReply = await conversation.handleMessage("User initiated /start command");
    // if (initialReply) bot.sendMessage(chatId, initialReply);
    await saveConversationState(chatId, restaurantId, conversation.getConversationFlow());
  });

  bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`[Telegram] /help command received from chatId: ${chatId} for restaurant ${restaurantId}`);
    const helpMessage = `I can help you with:\n\n1. 📅 Making a reservation - just tell me when you'd like to visit and how many people.\n2. ℹ️ Information about the restaurant - ask about hours, location, or menu.\n\nWhat would you like to do?`;
    bot.sendMessage(chatId, helpMessage);
  });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const messageText = msg.text;

    if (!messageText || messageText.startsWith('/')) { // Basic command check, specific commands handled by onText
      return;
    }

    console.log(`[Telegram] 📱 Message: "${messageText}" from chat ${chatId} for restaurant ${restaurantId}`);
    await bot.sendChatAction(chatId, 'typing');

    try {
      const conversation = await getOrCreateConversation(chatId, restaurantId);
      const replyMessage = await conversation.handleMessage(messageText); // Get the response string

      if (replyMessage) { // Ensure there's a reply to send
        await bot.sendMessage(chatId, replyMessage);
      } else {
        console.warn(`[Telegram] No reply message generated for chat ${chatId}, message: "${messageText}"`);
        // Potentially send a generic fallback if ActiveConversation returns nothing unexpectedly
      }

      const currentFlow = conversation.getConversationFlow();

      // --- Post-Response Action Handling ---
      // This section determines if additional actions (like booking or suggesting alternatives) are needed
      // based on the conversation's current state.
      // A more robust way would be for `handleMessage` to return a structured object:
      // e.g., { reply: "...", action?: "book" | "suggest_alternatives", data?: any }

      if (currentFlow.stage === 'confirming') {
        console.log(`[Telegram] Conversation for chat ${chatId} reached 'confirming' stage. Checking collected info.`);
        const { date, time, guests, name, phone, special_requests } = currentFlow.collectedInfo;

        if (date && time && guests && name && phone) {
          console.log(`[Telegram] All info collected for chat ${chatId}. Attempting to create reservation.`);
          const bookingResult = await createTelegramReservation(
            restaurantId, date, time, guests, name, phone, special_requests
          );

          if (bookingResult.success && bookingResult.reservation) {
            // const { CacheInvalidation } from '../cache'; // If needed for other parts of system
            // CacheInvalidation.onReservationChange(restaurantId, date);
            const tableInfo = bookingResult.reservation.table?.name ? `Table ${bookingResult.reservation.table.name}` : 'a perfect table';

            // This confirmation message could also be standardized via ResponseFormatter
            const finalConfirmation = responseFormatter.generateBookingConfirmation(currentFlow, responseFormatter.createBookingSummary(currentFlow.collectedInfo)) + // General part
                                      `\n\nWe've assigned you ${tableInfo}. We look forward to serving you at ${restaurant.name}!`;
            await bot.sendMessage(chatId, finalConfirmation);

            activeBotConversations.delete(chatId); // Reset conversation after successful booking
            await deleteConversationState(chatId, restaurantId);
          } else {
            await bot.sendMessage(chatId, `I'm sorry, there was an issue confirming your booking: ${bookingResult.message}. Let's try to find another option.`);
            // Here, you might want to transition the conversation state to suggest alternatives
            // e.g., by calling conversation.handleMessage("System: booking failed, suggest alternatives");
            // or by having a dedicated method in ActiveConversation to handle booking failure.
            const availabilityData = await getAvailableTimeSlots(restaurantId, date, guests, { requestedTime: time, maxResults: 3 });
            const alternativeMessage = responseFormatter.generateSmartAlternativeMessageText(name, time, guests, availabilityData);
            await bot.sendMessage(chatId, alternativeMessage);
            // Update conversation stage to 'suggesting_alternatives' if not already handled by AI
            // currentFlow.stage = 'suggesting_alternatives'; // This should ideally be done within ActiveConversation
          }
        } else {
          console.warn(`[Telegram] Chat ${chatId} in 'confirming' stage but info is incomplete. AI/Logic error likely.`);
          // The conversation manager should ideally not reach 'confirming' without full info.
          // Send a message asking for the remaining details again.
          // This could be a call to conversation.handleMessage("System: request missing details again");
        }
      } else if (currentFlow.stage === 'suggesting_alternatives' && replyMessage.includes("Which one would you prefer?")) {
         // If AI decided to show alternatives and the response prompts for selection,
         // the next message from the user will be their choice. ActiveConversation should handle this.
         // No immediate action here, wait for user's next message.
      }


      await saveConversationState(chatId, restaurantId, currentFlow);

    } catch (error) {
      console.error(`[Telegram] ❌ Error in message handler for chat ${chatId} (Restaurant ${restaurantId}):`, error);
      // Send a generic error message to the user
      try {
        await bot.sendMessage(chatId, 'I seem to be having a little trouble at the moment. Please try your request again shortly. 🙏');
      } catch (sendError) {
        console.error(`[Telegram] ‼️ Failed to send error message to chat ${chatId}:`, sendError);
      }
    }
  });

  // Handle callback queries (for inline keyboards, e.g., selecting a suggested time)
  bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const data = callbackQuery.data; // e.g., "select_time_10:30_table_5"

    if (!msg || !data) return;
    const chatId = msg.chat.id;

    await bot.answerCallbackQuery(callbackQuery.id); // Acknowledge the callback
    console.log(`[Telegram] Callback query: "${data}" from chat ${chatId} for restaurant ${restaurantId}`);
    await bot.sendChatAction(chatId, 'typing');

    try {
        const conversation = await getOrCreateConversation(chatId, restaurantId);
        // We need a way for ActiveConversation to process this structured data.
        // Option 1: Simulate it as a user message.
        // Option 2: Add a specific method to ActiveConversation e.g., `handleCallbackData(data)`
        // For now, let's simulate it as a message.
        const simulatedMessage = `User selected: ${data}`; // Or more structured if ActiveConversation expects it
        const replyMessage = await conversation.handleMessage(simulatedMessage);

        if (replyMessage) {
            await bot.sendMessage(chatId, replyMessage);
        }
        // Further actions (like booking the selected slot) would follow the same logic as in the main message handler,
        // checking currentFlow.stage.
        const currentFlow = conversation.getConversationFlow();
        // ... (add booking logic similar to the 'confirming' stage in main message handler if applicable) ...

        await saveConversationState(chatId, restaurantId, currentFlow);

    } catch (error) {
        console.error(`[Telegram] ❌ Error in callback_query handler for chat ${chatId}:`, error);
        await bot.sendMessage(chatId, 'Sorry, I couldn\'t process that selection. Please try again.');
    }
  });

  bot.on('polling_error', (error) => {
    console.error(`[Telegram] 🚫 Polling error for restaurant ${restaurantId}: ${error.code} - ${error.message}`);
    // More specific error handling can be added here, e.g., for ETELEGRAM issues
  });

  bot.on('webhook_error', (error) => {
    console.error(`[Telegram] 🚫 Webhook error for restaurant ${restaurantId}: ${error.code} - ${error.message}`);
  });

  console.log(`[Telegram] 💡 All event listeners registered for restaurant ${restaurantId}. Bot is fully active.`);
  return bot;
}// server/services/telegram-booking.ts

import { storage } from '../storage';
// The core createReservation function is imported from booking.ts
import { createReservation, type BookingRequest } from './booking'; // Assuming BookingRequest is exported from booking.ts

/**
 * Creates a reservation originating from a Telegram interaction.
 * It handles finding or creating a guest based on phone number
 * and then calls the core booking service.
 *
 * @param restaurantId - The ID of the restaurant.
 * @param date - The desired date for the reservation (YYYY-MM-DD).
 * @param time - The desired time for the reservation (HH:MM).
 * @param guests - The number of guests for the reservation.
 * @param name - The name of the guest making the reservation.
 * @param phone - The phone number of the guest.
 * @param comments - Optional special requests or comments for the reservation.
 * @returns A promise that resolves to an object indicating success or failure,
 * along with the reservation details or an error message.
 */
export async function createTelegramReservation(
  restaurantId: number,
  date: string,
  time: string,
  guests: number,
  name: string,
  phone: string,
  comments?: string
): Promise<{
  success: boolean;
  reservation?: any; // Should match the return type of booking.ts#createReservation's reservation
  message: string;
}> {
  try {
    console.log(`[TelegramBooking] Attempting to create reservation via Telegram: ${guests} guests for ${name} on ${date} at ${time}`);

    // Step 1: Find or create the guest by phone number.
    // This logic is sound and remains relevant for Telegram-originated bookings.
    let guest = await storage.getGuestByPhone(phone);
    if (!guest) {
      console.log(`[TelegramBooking] Guest with phone ${phone} not found. Creating new guest: ${name}`);
      guest = await storage.createGuest({
        name,
        phone,
        email: '', // Email is not typically collected via Telegram chat initially
        language: 'en', // Default language, could be detected or passed if available
        // birthday, comments, tags could be added later if collected
      });
      console.log(`[TelegramBooking] ✨ Created new guest ID: ${guest.id} for ${name}`);
    } else {
      console.log(`[TelegramBooking] Found existing guest ID: ${guest.id} for phone ${phone}`);
      // Optionally, update guest name if it's different and you want to allow this.
      // For now, we use the existing guest record.
    }

    // Step 2: Prepare the booking request for the core booking service.
    const bookingRequest: BookingRequest = {
      restaurantId,
      guestId: guest.id,
      date,
      time,
      guests,
      comments: comments || '', // Ensure comments is a string
      source: 'telegram', // Set the source of the booking
    };

    // Step 3: Call the core `createReservation` function (from booking.ts)
    // This function handles the smart table assignment and actual reservation creation.
    console.log('[TelegramBooking] Calling core createReservation service with request:', bookingRequest);
    const result = await createReservation(bookingRequest);

    if (result.success) {
      console.log(`[TelegramBooking] ✅ Core booking service successfully created reservation ID: ${result.reservation?.id}`);
    } else {
      console.warn(`[TelegramBooking] Core booking service failed: ${result.message}`);
    }

    return result;

  } catch (error: unknown) {
    console.error('❌ [TelegramBooking] Unexpected error during createTelegramReservation:', error);
    // Ensure a consistent error response structure
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred during booking.';
    return {
      success: false,
      message: `Failed to create reservation via Telegram: ${errorMessage}`,
    };
  }
}

// The function `getAlternativeTimes` and its helpers (`getAvailableTablesForTime`, `formatTime`)
// have been REMOVED from this file.
// Similar and more comprehensive functionality is now expected to be provided by
// `availability.service.ts` (e.g., the `getAvailableTimeSlots` function).
// The refactored `telegram.ts` should use that service when alternatives are needed.