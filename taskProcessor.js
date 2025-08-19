const AWS = require('aws-sdk');
const sqs = new AWS.SQS();
const dynamodb = new AWS.DynamoDB.DocumentClient();
const { simulateRandomFailure } = require('./utils/randomFailure');

module.exports.processTask = async (event) => {
  const record = event.Records[0];
  const { taskId } = JSON.parse(record.body);
  const receiptHandle = record.receiptHandle;
  
  // Extract SQS message attributes to track actual receive count
  const sqsReceiveCount = parseInt(record.attributes.ApproximateReceiveCount || '1');

  try {
    console.log(`Processing task: ${taskId} (SQS receive count: ${sqsReceiveCount})`);

    // Get current task state from DynamoDB
    const { Item: task } = await dynamodb.get({
      TableName: process.env.TASKS_TABLE_NAME,
      Key: { taskId }
    }).promise();

    if (!task) {
      console.error(`Task not found in DynamoDB: ${taskId}`);
      return;
    }

    // Update task status to PROCESSING and sync with SQS receive count
    await dynamodb.update({
      TableName: process.env.TASKS_TABLE_NAME,
      Key: { taskId },
      UpdateExpression: 'SET #status = :status, attempts = :attempts, updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':status': 'PROCESSING',
        ':attempts': sqsReceiveCount,
        ':updatedAt': new Date().toISOString()
      }
    }).promise();

    // Simulate 30% failure rate
    simulateRandomFailure(0.3);

    // If we reach here, task succeeded
    await dynamodb.update({
      TableName: process.env.TASKS_TABLE_NAME,
      Key: { taskId },
      UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt, completedAt = :completedAt',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':status': 'COMPLETED',
        ':updatedAt': new Date().toISOString(),
        ':completedAt': new Date().toISOString()
      }
    }).promise();

    console.log(`Task processed successfully: ${taskId} (attempt ${sqsReceiveCount})`);

  } catch (error) {
    console.error(`Error processing task: ${taskId}, attempt ${sqsReceiveCount}:`, error.message);

    try {
      // Update task with error information
      await dynamodb.update({
        TableName: process.env.TASKS_TABLE_NAME,
        Key: { taskId },
        UpdateExpression: 'SET #status = :status, lastError = :error, updatedAt = :updatedAt',
        ExpressionAttributeNames: {
          '#status': 'status'
        },
        ExpressionAttributeValues: {
          ':status': 'FAILED',
          ':error': error.message,
          ':updatedAt': new Date().toISOString()
        }
      }).promise();

      // Implement exponential backoff using ChangeMessageVisibility and let SQS handle retries
      if (sqsReceiveCount < 3) {
        const delays = [5, 10, 20]; // seconds: 5s for 1st failure, then 10s, then 20s
        const delaySeconds = delays[sqsReceiveCount - 1] || 20;
        console.log(`Task ${taskId} failed on attempt ${sqsReceiveCount}, applying ${delaySeconds}s visibility timeout before retry`);
        try {
          await sqs.changeMessageVisibility({
            QueueUrl: process.env.TASK_QUEUE_URL,
            ReceiptHandle: receiptHandle,
            VisibilityTimeout: delaySeconds
          }).promise();
        } catch (sqsError) {
          console.error(`Error changing message visibility for task ${taskId}:`, sqsError.message);
        }
        // Re-throw to signal failure so SQS increments receive count and handles redrive to DLQ after maxReceiveCount
      } else {
        console.log(`Task ${taskId} reached max retries (${sqsReceiveCount}), next failure will route to DLQ`);
      }

    } catch (dbError) {
      console.error(`Error updating DynamoDB for failed task ${taskId}:`, dbError.message);
    }

    // Re-throw error to trigger SQS retry mechanism (will go to DLQ after maxReceiveCount)
    throw error;
  }
};
