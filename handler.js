const AWS = require('aws-sdk');
const sqs = new AWS.SQS();
const dynamodb = new AWS.DynamoDB.DocumentClient();
const { v4: uuidv4 } = require('uuid');

module.exports.submitTask = async (event) => {
  try {
    // Parse and validate request body
    const body = JSON.parse(event.body || '{}');
    const { taskId, payload } = body;

    // Validate required fields
    if (!payload || typeof payload !== 'object') {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: 'Invalid request: payload is required and must be an object' }),
      };
    }

    // Use provided taskId or generate new one
    const finalTaskId = taskId || uuidv4();

    // Validate taskId format if provided
    if (taskId && (typeof taskId !== 'string' || taskId.trim().length === 0)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: 'Invalid request: taskId must be a non-empty string' }),
      };
    }

    const timestamp = new Date().toISOString();

    // Store task in DynamoDB
    await dynamodb.put({
      TableName: process.env.TASKS_TABLE_NAME,
      Item: {
        taskId: finalTaskId,
        payload: payload,
        status: 'SUBMITTED',
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    }).promise();

    // Send message to SQS queue
    const sqsParams = {
      QueueUrl: process.env.TASK_QUEUE_URL,
      MessageBody: JSON.stringify({ taskId: finalTaskId, payload }),
    };

    await sqs.sendMessage(sqsParams).promise();

    console.log(`Task submitted successfully: ${finalTaskId}`);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        message: 'Task submitted successfully', 
        taskId: finalTaskId,
        status: 'SUBMITTED'
      }),
    };
  } catch (error) {
    console.error('Error submitting task:', error);
    
    // Handle specific error types
    if (error.name === 'SyntaxError') {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: 'Invalid JSON in request body' }),
      };
    }

    return {
      statusCode: 500,
      body: JSON.stringify({ 
        message: 'Internal server error while submitting task',
        error: error.message 
      }),
    };
  }
};
