#!/bin/bash

# Load environment variables from .env file if it exists
if [[ -f .env ]]; then
  source .env
fi

if [[ -z "$TASKS_QUEUE_URL" || -z "$DLQ_URL" || -z "$API_ID" || -z "$AWS_REGION" ]]; then
  echo "Environment variables not set properly"
  exit 1
fi

echo "Using API: https://$API_ID.execute-api.eu-central-1.amazonaws.com/dev/task"
echo "Queue URL: $TASKS_QUEUE_URL"
echo "DLQ URL: $DLQ_URL"
echo ""

# Helper function to count messages in a queue
count_messages() {
  aws sqs get-queue-attributes \
    --queue-url "$1" \
    --attribute-names ApproximateNumberOfMessages \
    --query 'Attributes.ApproximateNumberOfMessages' \
    --output text
}

echo "Submitting test tasks..."

NUM_TASKS=30

# Submit tasks and capture task IDs
TASK_IDS=()
for i in $(seq 1 $NUM_TASKS); do
  RESPONSE=$(curl -s -X POST https://$API_ID.execute-api.eu-central-1.amazonaws.com/dev/task \
    -H "Content-Type: application/json" \
    -d "{\"payload\": {\"name\": \"Test Task $i\", \"data\": $i, \"timestamp\": \"$(date -Iseconds)\"}}")
  echo "Task $i response: $RESPONSE"
  
  # Extract task ID from response using multiple methods
  TASK_ID=$(echo "$RESPONSE" | grep -o '"taskId":"[^"]*"' | cut -d'"' -f4)
  if [[ -z "$TASK_ID" ]]; then
    # Fallback: try with jq if available
    TASK_ID=$(echo "$RESPONSE" | jq -r '.taskId' 2>/dev/null)
  fi
  if [[ -z "$TASK_ID" ]] || [[ "$TASK_ID" == "null" ]]; then
    # Fallback: try with sed
    TASK_ID=$(echo "$RESPONSE" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
  fi
  
  if [[ -n "$TASK_ID" ]] && [[ "$TASK_ID" != "null" ]]; then
    TASK_IDS+=("$TASK_ID")
  else
    echo "  ⚠️ Could not extract taskId from response: $RESPONSE"
  fi
done

echo ""
echo "📝 Captured ${#TASK_IDS[@]} task IDs for tracking"

echo -e "\nWaiting for Lambda to process (including retries with exponential backoff)..."
echo "This may take up to 180 seconds due to retry delays (5s, 10s, 20s)..."
sleep 10

# Additional wait: poll DynamoDB until all submitted tasks reach a terminal status or timeout
TERMINAL_WAIT=120
TW=0
while [[ ${#TASK_IDS[@]} -gt 0 && $TW -lt $TERMINAL_WAIT ]]; do
  TERMINAL=0
  for TID in "${TASK_IDS[@]}"; do
    S=$(aws dynamodb get-item --table-name TasksTable \
      --key "{\"taskId\":{\"S\":\"$TID\"}}" \
      --query 'Item.status.S' --output text 2>/dev/null)
    if [[ "$S" == "COMPLETED" || "$S" == "DEAD_LETTER" ]]; then
      TERMINAL=$((TERMINAL+1))
    fi
  done
  if [[ $TERMINAL -ge ${#TASK_IDS[@]} ]]; then
    break
  fi
  sleep 5
  TW=$((TW+5))
done

# Get final counts
MAIN_QUEUE_COUNT=$(count_messages "$TASKS_QUEUE_URL")
DLQ_COUNT=$(count_messages "$DLQ_URL")
# Note: DLQ_COUNT shows current queue depth, not total processed by DLQ
# Real DLQ activity is tracked in DynamoDB and CloudWatch logs
SUCCESS_COUNT=$((NUM_TASKS - MAIN_QUEUE_COUNT - DLQ_COUNT))

# Print summary
echo -e "\n===== TASK PROCESSING SUMMARY ====="
echo "✅ Tasks successfully processed: $SUCCESS_COUNT"
echo "⚠ Tasks still in main queue: $MAIN_QUEUE_COUNT"
echo "❌ Tasks currently in DLQ: $DLQ_COUNT (processed DLQ tasks logged to CloudWatch)"
echo "==================================="
echo ""
echo "📊 Analyzing final outcomes for the ${#TASK_IDS[@]} submitted tasks..."

FIRST_SUCCESS_COUNT=0
FIRST_FAILURE_COUNT=0

echo "   Checking task statuses in DynamoDB..."

for i in "${!TASK_IDS[@]}"; do
  TASK_ID="${TASK_IDS[i]}"
  if [[ -n "$TASK_ID" ]]; then
    # Fetch attempts to compute first-attempt stats
    ATTEMPTS=$(aws dynamodb get-item --table-name TasksTable \
      --key "{\"taskId\":{\"S\":\"$TASK_ID\"}}" \
      --query 'Item.attempts.N' --output text 2>/dev/null)
    if [[ "$ATTEMPTS" =~ ^[0-9]+$ ]]; then
      if [[ $ATTEMPTS -eq 1 ]]; then
        ((FIRST_SUCCESS_COUNT++))
      elif [[ $ATTEMPTS -ge 2 ]]; then
        ((FIRST_FAILURE_COUNT++))
      fi
    fi
  fi
done

echo "SUCCESS: $FIRST_SUCCESS_COUNT"
echo "FAILURE: $FIRST_FAILURE_COUNT"
