import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tasks_v1 } from "googleapis";
import { TaskActions, TaskResources } from "./Tasks.js";

export function createMcpServer(tasks: tasks_v1.Tasks): Server {
  const server = new Server(
    {
      name: "example-servers/gtasks",
      version: "0.1.0",
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const [allTasks, nextPageToken] = await TaskResources.list(request, tasks);
    return {
      resources: allTasks.map((task) => ({
        uri: `gtasks:///${task.id}`,
        mimeType: "text/plain",
        name: task.title,
      })),
      nextCursor: nextPageToken,
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const task = await TaskResources.read(request, tasks);

    const taskDetails = [
      `Title: ${task.title || "No title"}`,
      `Status: ${task.status || "Unknown"}`,
      `Due: ${task.due || "Not set"}`,
      `Notes: ${task.notes || "No notes"}`,
      `Hidden: ${task.hidden || "Unknown"}`,
      `Parent: ${task.parent || "Unknown"}`,
      `Deleted?: ${task.deleted || "Unknown"}`,
      `Completed Date: ${task.completed || "Unknown"}`,
      `Position: ${task.position || "Unknown"}`,
      `ETag: ${task.etag || "Unknown"}`,
      `Links: ${task.links || "Unknown"}`,
      `Kind: ${task.kind || "Unknown"}`,
      `Created: ${task.updated || "Unknown"}`,
      `Updated: ${task.updated || "Unknown"}`,
    ].join("\n");

    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "text/plain",
          text: taskDetails,
        },
      ],
    };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "search",
          description: "Search for a task in Google Tasks",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search query",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "list",
          description: "List all tasks in Google Tasks",
          inputSchema: {
            type: "object",
            properties: {
              cursor: {
                type: "string",
                description: "Cursor for pagination",
              },
            },
          },
        },
        {
          name: "create",
          description: "Create a new task in Google Tasks",
          inputSchema: {
            type: "object",
            properties: {
              taskListId: {
                type: "string",
                description: "Task list ID",
              },
              title: {
                type: "string",
                description: "Task title",
              },
              notes: {
                type: "string",
                description: "Task notes",
              },
              due: {
                type: "string",
                description: "Due date (YYYY-MM-DD or ISO 8601 format, e.g. 2025-03-19)",
              },
            },
            required: ["title"],
          },
        },
        {
          name: "clear",
          description: "Clear completed tasks from a Google Tasks task list",
          inputSchema: {
            type: "object",
            properties: {
              taskListId: {
                type: "string",
                description: "Task list ID",
              },
            },
            required: ["taskListId"],
          },
        },
        {
          name: "delete",
          description: "Delete a task in Google Tasks",
          inputSchema: {
            type: "object",
            properties: {
              taskListId: {
                type: "string",
                description: "Task list ID",
              },
              id: {
                type: "string",
                description: "Task id",
              },
            },
            required: ["id", "taskListId"],
          },
        },
        {
          name: "list-tasklists",
          description: "List all task lists in Google Tasks",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "update",
          description: "Update a task in Google Tasks",
          inputSchema: {
            type: "object",
            properties: {
              taskListId: {
                type: "string",
                description: "Task list ID",
              },
              id: {
                type: "string",
                description: "Task ID",
              },
              uri: {
                type: "string",
                description: "Task URI",
              },
              title: {
                type: "string",
                description: "Task title",
              },
              notes: {
                type: "string",
                description: "Task notes",
              },
              status: {
                type: "string",
                enum: ["needsAction", "completed"],
                description: "Task status (needsAction or completed)",
              },
              due: {
                type: "string",
                description: "Due date (YYYY-MM-DD or ISO 8601 format, e.g. 2025-03-19)",
              },
            },
            required: ["id", "uri"],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "search") {
      return TaskActions.search(request, tasks);
    }
    if (request.params.name === "list") {
      return TaskActions.list(request, tasks);
    }
    if (request.params.name === "list-tasklists") {
      const response = await tasks.tasklists.list();
      const taskLists = response.data.items || [];
      const formatted = taskLists
        .map((list) => `${list.title} (ID: ${list.id})`)
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text:
              taskLists.length > 0
                ? `Found ${taskLists.length} task lists:\n${formatted}`
                : "No task lists found",
          },
        ],
      };
    }
    if (request.params.name === "create") {
      return TaskActions.create(request, tasks);
    }
    if (request.params.name === "update") {
      return TaskActions.update(request, tasks);
    }
    if (request.params.name === "delete") {
      return TaskActions.delete(request, tasks);
    }
    if (request.params.name === "clear") {
      return TaskActions.clear(request, tasks);
    }
    throw new Error("Tool not found");
  });

  return server;
}
