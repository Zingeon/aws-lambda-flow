// checkQueues.js
import dotenv from "dotenv";
import { SQSClient, ReceiveMessageCommand } from "@aws-sdk/client-sqs";

dotenv.config();

// Read environment variables
const { TASKS_QUEUE_URL, DLQ_URL, AWS_REGION } = process.env;

if (!TASKS_QUEUE_URL || !DLQ_URL) {
  console.error("Error: TASKS_QUEUE_URL or DLQ_URL is not defined in environment variables");
  process.exit(1);
}

// Create SQS client
const sqsClient = new SQSClient({ region: AWS_REGION || "eu-central-1" });

// Function to receive messages from a queue
async function receiveMessages(queueUrl) {
  try {
    const command = new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 0, // short polling
      VisibilityTimeout: 20,
    });

    const data = await sqsClient.send(command);

    if (!data.Messages || data.Messages.length === 0) {
      console.log(`No messages in queue: ${queueUrl}`);
      return;
    }

    for (const msg of data.Messages) {
      console.log("Message received:");
      try {
        const body = JSON.parse(msg.Body);
        console.log(JSON.stringify(body, null, 2));
      } catch {
        console.log("Cannot parse message body:", msg.Body);
      }
    }
  } catch (err) {
    console.error("Error receiving messages:", err);
  }
}

// Main function
async function checkQueues() {
  console.log("Checking main TaskQueue...");
  await receiveMessages(TASKS_QUEUE_URL);

  console.log("\nChecking Dead Letter Queue...");
  await receiveMessages(DLQ_URL);
}

// Run the script
checkQueues();
