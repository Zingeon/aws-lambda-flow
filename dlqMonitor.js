const AWS = require('aws-sdk');
const sqs = new AWS.SQS();
const dynamodb = new AWS.DynamoDB.DocumentClient();

module.exports.monitorDLQ = async (event) => {
  try {
    for (const record of event.Records) {
      const { taskId, payload } = JSON.parse(record.body);
      const receiptHandle = record.receiptHandle;

      console.log(`Processing DLQ message for task: ${taskId}`);

      try {
        // Get task details from DynamoDB to include error information
        const { Item: task } = await dynamodb.get({
          TableName: process.env.TASKS_TABLE_NAME,
          Key: { taskId }
        }).promise();

        // Update task status to indicate it's in DLQ
        if (task) {
          await dynamodb.update({
            TableName: process.env.TASKS_TABLE_NAME,
            Key: { taskId },
            UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
            ExpressionAttributeNames: {
              '#status': 'status'
            },
            ExpressionAttributeValues: {
              ':status': 'DEAD_LETTER',
              ':updatedAt': new Date().toISOString()
            }
          }).promise();
        }

        // Log comprehensive task failure details to CloudWatch
        const logData = {
          event: 'TASK_DEAD_LETTER',
          taskId: taskId,
          payload: payload,
          attempts: task?.attempts || 'unknown',
          lastError: task?.lastError || 'No error details available',
          createdAt: task?.createdAt || 'unknown',
          failedAt: new Date().toISOString(),
          message: `Task ${taskId} has been moved to DLQ after ${task?.attempts || 'unknown'} attempts`
        };

        // Structured logging for CloudWatch
        console.log(JSON.stringify(logData, null, 2));

        // Also log a more readable format
        console.log(`
========== DEAD LETTER TASK ==========
Task ID: ${taskId}
Attempts: ${task?.attempts || 'unknown'}
Last Error: ${task?.lastError || 'No error details available'}
Payload: ${JSON.stringify(payload, null, 2)}
Created At: ${task?.createdAt || 'unknown'}
Failed At: ${new Date().toISOString()}
====================================
        `);

      } catch (dbError) {
        console.error(`Error retrieving task details from DynamoDB for ${taskId}:`, dbError.message);
        
        // Still log basic info even if DynamoDB fails
        console.log(JSON.stringify({
          event: 'TASK_DEAD_LETTER',
          taskId: taskId,
          payload: payload,
          error: 'Could not retrieve additional task details from DynamoDB',
          dbError: dbError.message,
          failedAt: new Date().toISOString()
        }, null, 2));
      }
    }

  } catch (error) {
    console.error('Error monitoring DLQ:', error.message);
    throw error;
  }
};
