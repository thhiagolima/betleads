export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      activation_runs: {
        Row: {
          created_at: string
          error: string | null
          finished_at: string | null
          id: string
          mode: string
          started_at: string
          status: string
          tenant_id: string
          totals: Json
        }
        Insert: {
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          mode: string
          started_at?: string
          status?: string
          tenant_id?: string
          totals?: Json
        }
        Update: {
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          mode?: string
          started_at?: string
          status?: string
          tenant_id?: string
          totals?: Json
        }
        Relationships: [
          {
            foreignKeyName: "activation_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_audit_logs: {
        Row: {
          action: string
          actor_user_id: string | null
          after_data: Json | null
          before_data: Json | null
          created_at: string
          id: string
          target_user_id: string | null
          tenant_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          after_data?: Json | null
          before_data?: Json | null
          created_at?: string
          id?: string
          target_user_id?: string | null
          tenant_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          after_data?: Json | null
          before_data?: Json | null
          created_at?: string
          id?: string
          target_user_id?: string | null
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "admin_audit_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_feedback: {
        Row: {
          ai_log_id: string | null
          created_at: string
          id: string
          motivo: string | null
          rating: string
          tenant_id: string
        }
        Insert: {
          ai_log_id?: string | null
          created_at?: string
          id?: string
          motivo?: string | null
          rating: string
          tenant_id?: string
        }
        Update: {
          ai_log_id?: string | null
          created_at?: string
          id?: string
          motivo?: string | null
          rating?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_feedback_ai_log_id_fkey"
            columns: ["ai_log_id"]
            isOneToOne: false
            referencedRelation: "ai_logs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_feedback_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_intents: {
        Row: {
          ativo: boolean
          campo_alvo: string | null
          created_at: string
          descricao: string | null
          id: string
          limite_padrao: number
          nome: string
          operador: string | null
          ordenacao: Json
          palavras_chave: string[]
          prioridade: number
          tenant_id: string
          updated_at: string
          valor_padrao: string | null
        }
        Insert: {
          ativo?: boolean
          campo_alvo?: string | null
          created_at?: string
          descricao?: string | null
          id?: string
          limite_padrao?: number
          nome: string
          operador?: string | null
          ordenacao?: Json
          palavras_chave?: string[]
          prioridade?: number
          tenant_id?: string
          updated_at?: string
          valor_padrao?: string | null
        }
        Update: {
          ativo?: boolean
          campo_alvo?: string | null
          created_at?: string
          descricao?: string | null
          id?: string
          limite_padrao?: number
          nome?: string
          operador?: string | null
          ordenacao?: Json
          palavras_chave?: string[]
          prioridade?: number
          tenant_id?: string
          updated_at?: string
          valor_padrao?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_intents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_logs: {
        Row: {
          audit: Json | null
          created_at: string
          id: string
          intent_detectada: string | null
          modelo: string | null
          origem_resposta: string | null
          pergunta: string
          resposta: string | null
          status: string
          tenant_id: string
        }
        Insert: {
          audit?: Json | null
          created_at?: string
          id?: string
          intent_detectada?: string | null
          modelo?: string | null
          origem_resposta?: string | null
          pergunta: string
          resposta?: string | null
          status?: string
          tenant_id?: string
        }
        Update: {
          audit?: Json | null
          created_at?: string
          id?: string
          intent_detectada?: string | null
          modelo?: string | null
          origem_resposta?: string | null
          pergunta?: string
          resposta?: string | null
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_synonyms: {
        Row: {
          ativo: boolean
          canonico: string
          created_at: string
          id: string
          tenant_id: string
          termo: string
          tipo: string
        }
        Insert: {
          ativo?: boolean
          canonico: string
          created_at?: string
          id?: string
          tenant_id?: string
          termo: string
          tipo?: string
        }
        Update: {
          ativo?: boolean
          canonico?: string
          created_at?: string
          id?: string
          tenant_id?: string
          termo?: string
          tipo?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_synonyms_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_training_examples: {
        Row: {
          ai_log_id: string | null
          ativo: boolean
          created_at: string
          filtros: Json
          fonte: string
          id: string
          intent: string | null
          pergunta: string
          resposta_ideal: string
          tags: string[]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          ai_log_id?: string | null
          ativo?: boolean
          created_at?: string
          filtros?: Json
          fonte?: string
          id?: string
          intent?: string | null
          pergunta: string
          resposta_ideal: string
          tags?: string[]
          tenant_id?: string
          updated_at?: string
        }
        Update: {
          ai_log_id?: string | null
          ativo?: boolean
          created_at?: string
          filtros?: Json
          fonte?: string
          id?: string
          intent?: string | null
          pergunta?: string
          resposta_ideal?: string
          tags?: string[]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_training_examples_ai_log_id_fkey"
            columns: ["ai_log_id"]
            isOneToOne: false
            referencedRelation: "ai_logs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_training_examples_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      antiban_settings: {
        Row: {
          auto_pause_enabled: boolean
          cooldown_hours: number
          created_at: string
          daily_limit: number
          delay_max_seconds: number
          delay_min_seconds: number
          hourly_limit: number
          id: string
          randomization_enabled: boolean
          singleton: boolean
          smart_suppression_enabled: boolean
          tenant_id: string
          updated_at: string
          warmup_days: number
          warmup_enabled: boolean
          warmup_initial_daily: number
          window_end: string
          window_start: string
        }
        Insert: {
          auto_pause_enabled?: boolean
          cooldown_hours?: number
          created_at?: string
          daily_limit?: number
          delay_max_seconds?: number
          delay_min_seconds?: number
          hourly_limit?: number
          id?: string
          randomization_enabled?: boolean
          singleton?: boolean
          smart_suppression_enabled?: boolean
          tenant_id?: string
          updated_at?: string
          warmup_days?: number
          warmup_enabled?: boolean
          warmup_initial_daily?: number
          window_end?: string
          window_start?: string
        }
        Update: {
          auto_pause_enabled?: boolean
          cooldown_hours?: number
          created_at?: string
          daily_limit?: number
          delay_max_seconds?: number
          delay_min_seconds?: number
          hourly_limit?: number
          id?: string
          randomization_enabled?: boolean
          singleton?: boolean
          smart_suppression_enabled?: boolean
          tenant_id?: string
          updated_at?: string
          warmup_days?: number
          warmup_enabled?: boolean
          warmup_initial_daily?: number
          window_end?: string
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "antiban_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_settings: {
        Row: {
          call_daily_limit: number
          call_paused: boolean
          created_at: string
          email_daily_limit: number
          email_paused: boolean
          id: string
          paused: boolean
          sms_daily_limit: number
          sms_paused: boolean
          tenant_id: string
          updated_at: string
          whatsapp_paused: boolean
        }
        Insert: {
          call_daily_limit?: number
          call_paused?: boolean
          created_at?: string
          email_daily_limit?: number
          email_paused?: boolean
          id?: string
          paused?: boolean
          sms_daily_limit?: number
          sms_paused?: boolean
          tenant_id?: string
          updated_at?: string
          whatsapp_paused?: boolean
        }
        Update: {
          call_daily_limit?: number
          call_paused?: boolean
          created_at?: string
          email_daily_limit?: number
          email_paused?: boolean
          id?: string
          paused?: boolean
          sms_daily_limit?: number
          sms_paused?: boolean
          tenant_id?: string
          updated_at?: string
          whatsapp_paused?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "automation_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      call_audio_generations: {
        Row: {
          audio_hash: string
          audio_path: string | null
          audio_url: string | null
          created_at: string
          duration_seconds: number | null
          error_message: string | null
          generation_status: Database["public"]["Enums"]["call_audio_status"]
          id: string
          lead_id: string | null
          original_text: string
          provider: string
          rendered_text: string
          script_id: string | null
          tenant_id: string
          voice_id: string | null
          voice_settings: Json
        }
        Insert: {
          audio_hash: string
          audio_path?: string | null
          audio_url?: string | null
          created_at?: string
          duration_seconds?: number | null
          error_message?: string | null
          generation_status?: Database["public"]["Enums"]["call_audio_status"]
          id?: string
          lead_id?: string | null
          original_text: string
          provider?: string
          rendered_text: string
          script_id?: string | null
          tenant_id?: string
          voice_id?: string | null
          voice_settings?: Json
        }
        Update: {
          audio_hash?: string
          audio_path?: string | null
          audio_url?: string | null
          created_at?: string
          duration_seconds?: number | null
          error_message?: string | null
          generation_status?: Database["public"]["Enums"]["call_audio_status"]
          id?: string
          lead_id?: string | null
          original_text?: string
          provider?: string
          rendered_text?: string
          script_id?: string | null
          tenant_id?: string
          voice_id?: string | null
          voice_settings?: Json
        }
        Relationships: [
          {
            foreignKeyName: "call_audio_generations_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "call_scripts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_audio_generations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      call_flow_block_sms: {
        Row: {
          block_id: string
          condition: Database["public"]["Enums"]["call_flow_sms_condition"]
          created_at: string
          id: string
          priority: number
          template: string
          tenant_id: string
          threshold_seconds: number | null
        }
        Insert: {
          block_id: string
          condition: Database["public"]["Enums"]["call_flow_sms_condition"]
          created_at?: string
          id?: string
          priority?: number
          template?: string
          tenant_id?: string
          threshold_seconds?: number | null
        }
        Update: {
          block_id?: string
          condition?: Database["public"]["Enums"]["call_flow_sms_condition"]
          created_at?: string
          id?: string
          priority?: number
          template?: string
          tenant_id?: string
          threshold_seconds?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "call_flow_block_sms_block_id_fkey"
            columns: ["block_id"]
            isOneToOne: false
            referencedRelation: "call_flow_blocks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_flow_block_sms_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      call_flow_blocks: {
        Row: {
          block_type: Database["public"]["Enums"]["call_flow_block_type"]
          created_at: string
          delay_after_seconds: number
          delay_seconds: number
          flow_id: string
          id: string
          max_attempts: number
          max_call_seconds: number
          name: string | null
          order_index: number
          script_id: string | null
          tenant_id: string
          updated_at: string
          voice_id: string | null
        }
        Insert: {
          block_type: Database["public"]["Enums"]["call_flow_block_type"]
          created_at?: string
          delay_after_seconds?: number
          delay_seconds?: number
          flow_id: string
          id?: string
          max_attempts?: number
          max_call_seconds?: number
          name?: string | null
          order_index?: number
          script_id?: string | null
          tenant_id?: string
          updated_at?: string
          voice_id?: string | null
        }
        Update: {
          block_type?: Database["public"]["Enums"]["call_flow_block_type"]
          created_at?: string
          delay_after_seconds?: number
          delay_seconds?: number
          flow_id?: string
          id?: string
          max_attempts?: number
          max_call_seconds?: number
          name?: string | null
          order_index?: number
          script_id?: string | null
          tenant_id?: string
          updated_at?: string
          voice_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "call_flow_blocks_flow_id_fkey"
            columns: ["flow_id"]
            isOneToOne: false
            referencedRelation: "call_flows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_flow_blocks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      call_flow_executions: {
        Row: {
          call_queue_id: string | null
          created_at: string
          flow_id: string
          id: string
          lead_id: string | null
          script_id: string | null
          sms_origin: string | null
          sms_sent: boolean
          status: string
          tenant_id: string
        }
        Insert: {
          call_queue_id?: string | null
          created_at?: string
          flow_id: string
          id?: string
          lead_id?: string | null
          script_id?: string | null
          sms_origin?: string | null
          sms_sent?: boolean
          status?: string
          tenant_id?: string
        }
        Update: {
          call_queue_id?: string | null
          created_at?: string
          flow_id?: string
          id?: string
          lead_id?: string | null
          script_id?: string | null
          sms_origin?: string | null
          sms_sent?: boolean
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_flow_executions_flow_id_fkey"
            columns: ["flow_id"]
            isOneToOne: false
            referencedRelation: "call_flows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_flow_executions_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "call_scripts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_flow_executions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      call_flow_history: {
        Row: {
          block_index: number | null
          created_at: string
          detail: Json
          event_type: string
          flow_id: string
          id: string
          player_id: string | null
          progress_id: string | null
          tenant_id: string
        }
        Insert: {
          block_index?: number | null
          created_at?: string
          detail?: Json
          event_type: string
          flow_id: string
          id?: string
          player_id?: string | null
          progress_id?: string | null
          tenant_id?: string
        }
        Update: {
          block_index?: number | null
          created_at?: string
          detail?: Json
          event_type?: string
          flow_id?: string
          id?: string
          player_id?: string | null
          progress_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_flow_history_progress_id_fkey"
            columns: ["progress_id"]
            isOneToOne: false
            referencedRelation: "call_flow_progress"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_flow_history_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      call_flow_post_action: {
        Row: {
          created_at: string
          delay_seconds: number
          flow_id: string
          id: string
          min_listened_seconds: number
          sms_mode: Database["public"]["Enums"]["call_flow_sms_mode"]
          sms_template: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          delay_seconds?: number
          flow_id: string
          id?: string
          min_listened_seconds?: number
          sms_mode?: Database["public"]["Enums"]["call_flow_sms_mode"]
          sms_template?: string
          tenant_id?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          delay_seconds?: number
          flow_id?: string
          id?: string
          min_listened_seconds?: number
          sms_mode?: Database["public"]["Enums"]["call_flow_sms_mode"]
          sms_template?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_flow_post_action_flow_id_fkey"
            columns: ["flow_id"]
            isOneToOne: true
            referencedRelation: "call_flows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_flow_post_action_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      call_flow_progress: {
        Row: {
          attempts_on_block: number
          current_block_index: number
          exit_reason: string | null
          flow_id: string
          id: string
          last_call_at: string | null
          last_call_duration: number | null
          last_call_result: string | null
          lead_id: string | null
          next_run_at: string
          phone_e164: string | null
          player_id: string | null
          started_at: string
          status: Database["public"]["Enums"]["call_flow_progress_status"]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          attempts_on_block?: number
          current_block_index?: number
          exit_reason?: string | null
          flow_id: string
          id?: string
          last_call_at?: string | null
          last_call_duration?: number | null
          last_call_result?: string | null
          lead_id?: string | null
          next_run_at?: string
          phone_e164?: string | null
          player_id?: string | null
          started_at?: string
          status?: Database["public"]["Enums"]["call_flow_progress_status"]
          tenant_id?: string
          updated_at?: string
        }
        Update: {
          attempts_on_block?: number
          current_block_index?: number
          exit_reason?: string | null
          flow_id?: string
          id?: string
          last_call_at?: string | null
          last_call_duration?: number | null
          last_call_result?: string | null
          lead_id?: string | null
          next_run_at?: string
          phone_e164?: string | null
          player_id?: string | null
          started_at?: string
          status?: Database["public"]["Enums"]["call_flow_progress_status"]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_flow_progress_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      call_flow_scripts: {
        Row: {
          created_at: string
          flow_id: string
          id: string
          is_active: boolean
          order_index: number
          script_id: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          flow_id: string
          id?: string
          is_active?: boolean
          order_index?: number
          script_id: string
          tenant_id?: string
        }
        Update: {
          created_at?: string
          flow_id?: string
          id?: string
          is_active?: boolean
          order_index?: number
          script_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_flow_scripts_flow_id_fkey"
            columns: ["flow_id"]
            isOneToOne: false
            referencedRelation: "call_flows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_flow_scripts_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "call_scripts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_flow_scripts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      call_flows: {
        Row: {
          avoid_last_script: boolean
          created_at: string
          exit_conditions: Json
          id: string
          is_active: boolean
          name: string
          randomize_scripts: boolean
          tenant_id: string
          trigger_name: string | null
          updated_at: string
        }
        Insert: {
          avoid_last_script?: boolean
          created_at?: string
          exit_conditions?: Json
          id?: string
          is_active?: boolean
          name: string
          randomize_scripts?: boolean
          tenant_id?: string
          trigger_name?: string | null
          updated_at?: string
        }
        Update: {
          avoid_last_script?: boolean
          created_at?: string
          exit_conditions?: Json
          id?: string
          is_active?: boolean
          name?: string
          randomize_scripts?: boolean
          tenant_id?: string
          trigger_name?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_flows_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      call_history: {
        Row: {
          audio_url: string | null
          call_queue_id: string | null
          created_at: string
          duration_seconds: number | null
          error_message: string | null
          id: string
          lead_id: string | null
          provider: string | null
          provider_call_id: string | null
          provider_response: Json
          provider_status_code: number | null
          recording_url: string | null
          rendered_text: string | null
          result: string | null
          script_id: string | null
          status: Database["public"]["Enums"]["call_history_status"]
          tenant_id: string
          to_phone: string | null
        }
        Insert: {
          audio_url?: string | null
          call_queue_id?: string | null
          created_at?: string
          duration_seconds?: number | null
          error_message?: string | null
          id?: string
          lead_id?: string | null
          provider?: string | null
          provider_call_id?: string | null
          provider_response?: Json
          provider_status_code?: number | null
          recording_url?: string | null
          rendered_text?: string | null
          result?: string | null
          script_id?: string | null
          status?: Database["public"]["Enums"]["call_history_status"]
          tenant_id?: string
          to_phone?: string | null
        }
        Update: {
          audio_url?: string | null
          call_queue_id?: string | null
          created_at?: string
          duration_seconds?: number | null
          error_message?: string | null
          id?: string
          lead_id?: string | null
          provider?: string | null
          provider_call_id?: string | null
          provider_response?: Json
          provider_status_code?: number | null
          recording_url?: string | null
          rendered_text?: string | null
          result?: string | null
          script_id?: string | null
          status?: Database["public"]["Enums"]["call_history_status"]
          tenant_id?: string
          to_phone?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "call_history_call_queue_id_fkey"
            columns: ["call_queue_id"]
            isOneToOne: false
            referencedRelation: "call_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_history_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "call_scripts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_history_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      call_providers: {
        Row: {
          api_key: string | null
          api_secret: string | null
          auth_type: Database["public"]["Enums"]["call_provider_auth"]
          base_url: string | null
          created_at: string
          daily_limit: number
          headers_config: Json
          hourly_limit: number
          id: string
          integration_mode: Database["public"]["Enums"]["call_provider_mode"]
          is_default: boolean
          payload_template: Json
          phone_number: string | null
          provider_name: string
          provider_type: Database["public"]["Enums"]["call_provider_type"]
          status: string
          tenant_id: string
          updated_at: string
          webhook_url: string | null
        }
        Insert: {
          api_key?: string | null
          api_secret?: string | null
          auth_type?: Database["public"]["Enums"]["call_provider_auth"]
          base_url?: string | null
          created_at?: string
          daily_limit?: number
          headers_config?: Json
          hourly_limit?: number
          id?: string
          integration_mode?: Database["public"]["Enums"]["call_provider_mode"]
          is_default?: boolean
          payload_template?: Json
          phone_number?: string | null
          provider_name: string
          provider_type: Database["public"]["Enums"]["call_provider_type"]
          status?: string
          tenant_id?: string
          updated_at?: string
          webhook_url?: string | null
        }
        Update: {
          api_key?: string | null
          api_secret?: string | null
          auth_type?: Database["public"]["Enums"]["call_provider_auth"]
          base_url?: string | null
          created_at?: string
          daily_limit?: number
          headers_config?: Json
          hourly_limit?: number
          id?: string
          integration_mode?: Database["public"]["Enums"]["call_provider_mode"]
          is_default?: boolean
          payload_template?: Json
          phone_number?: string | null
          provider_name?: string
          provider_type?: Database["public"]["Enums"]["call_provider_type"]
          status?: string
          tenant_id?: string
          updated_at?: string
          webhook_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "call_providers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      call_queue: {
        Row: {
          attempts: number
          audio_generation_id: string | null
          audio_url: string | null
          created_at: string
          id: string
          lead_id: string | null
          max_attempts: number
          phone_number: string | null
          priority: number
          provider_request_id: string | null
          provider_response: Json | null
          provider_status: string | null
          scheduled_at: string
          script_id: string | null
          status: Database["public"]["Enums"]["call_queue_status"]
          tenant_id: string
          trigger_name: string | null
          updated_at: string
          voice_asset_id: string | null
        }
        Insert: {
          attempts?: number
          audio_generation_id?: string | null
          audio_url?: string | null
          created_at?: string
          id?: string
          lead_id?: string | null
          max_attempts?: number
          phone_number?: string | null
          priority?: number
          provider_request_id?: string | null
          provider_response?: Json | null
          provider_status?: string | null
          scheduled_at?: string
          script_id?: string | null
          status?: Database["public"]["Enums"]["call_queue_status"]
          tenant_id?: string
          trigger_name?: string | null
          updated_at?: string
          voice_asset_id?: string | null
        }
        Update: {
          attempts?: number
          audio_generation_id?: string | null
          audio_url?: string | null
          created_at?: string
          id?: string
          lead_id?: string | null
          max_attempts?: number
          phone_number?: string | null
          priority?: number
          provider_request_id?: string | null
          provider_response?: Json | null
          provider_status?: string | null
          scheduled_at?: string
          script_id?: string | null
          status?: Database["public"]["Enums"]["call_queue_status"]
          tenant_id?: string
          trigger_name?: string | null
          updated_at?: string
          voice_asset_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "call_queue_audio_generation_id_fkey"
            columns: ["audio_generation_id"]
            isOneToOne: false
            referencedRelation: "call_audio_generations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_queue_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "call_scripts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_queue_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_queue_voice_asset_id_fkey"
            columns: ["voice_asset_id"]
            isOneToOne: false
            referencedRelation: "journey_voice_assets"
            referencedColumns: ["id"]
          },
        ]
      }
      call_script_versions: {
        Row: {
          changed_by: string | null
          content: string
          created_at: string
          default_voice_id: string | null
          id: string
          name: string
          script_id: string
          status: Database["public"]["Enums"]["call_script_status"]
          tenant_id: string
          version: number
          voice_settings: Json
        }
        Insert: {
          changed_by?: string | null
          content: string
          created_at?: string
          default_voice_id?: string | null
          id?: string
          name: string
          script_id: string
          status: Database["public"]["Enums"]["call_script_status"]
          tenant_id: string
          version: number
          voice_settings?: Json
        }
        Update: {
          changed_by?: string | null
          content?: string
          created_at?: string
          default_voice_id?: string | null
          id?: string
          name?: string
          script_id?: string
          status?: Database["public"]["Enums"]["call_script_status"]
          tenant_id?: string
          version?: number
          voice_settings?: Json
        }
        Relationships: [
          {
            foreignKeyName: "call_script_versions_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "call_scripts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_script_versions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      call_scripts: {
        Row: {
          content: string
          created_at: string
          default_voice_id: string | null
          id: string
          name: string
          provider: string
          status: Database["public"]["Enums"]["call_script_status"]
          tenant_id: string
          trigger_name: string | null
          updated_at: string
          version: number
          voice_settings: Json
        }
        Insert: {
          content: string
          created_at?: string
          default_voice_id?: string | null
          id?: string
          name: string
          provider?: string
          status?: Database["public"]["Enums"]["call_script_status"]
          tenant_id?: string
          trigger_name?: string | null
          updated_at?: string
          version?: number
          voice_settings?: Json
        }
        Update: {
          content?: string
          created_at?: string
          default_voice_id?: string | null
          id?: string
          name?: string
          provider?: string
          status?: Database["public"]["Enums"]["call_script_status"]
          tenant_id?: string
          trigger_name?: string | null
          updated_at?: string
          version?: number
          voice_settings?: Json
        }
        Relationships: [
          {
            foreignKeyName: "call_scripts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_drafts: {
        Row: {
          asset_id: string | null
          asset_kind: string | null
          asset_snapshot: Json | null
          audience_criteria: Json | null
          audience_id: string | null
          channel: string
          content: string
          created_at: string
          created_by: string
          id: string
          idempotency_key: string
          name: string
          payload: Json
          scheduled_at: string | null
          status: string
          submitted_at: string | null
          tenant_id: string
          track_links: boolean
          updated_at: string
          version: number
        }
        Insert: {
          asset_id?: string | null
          asset_kind?: string | null
          asset_snapshot?: Json | null
          audience_criteria?: Json | null
          audience_id?: string | null
          channel: string
          content?: string
          created_at?: string
          created_by: string
          id?: string
          idempotency_key: string
          name?: string
          payload?: Json
          scheduled_at?: string | null
          status?: string
          submitted_at?: string | null
          tenant_id: string
          track_links?: boolean
          updated_at?: string
          version?: number
        }
        Update: {
          asset_id?: string | null
          asset_kind?: string | null
          asset_snapshot?: Json | null
          audience_criteria?: Json | null
          audience_id?: string | null
          channel?: string
          content?: string
          created_at?: string
          created_by?: string
          id?: string
          idempotency_key?: string
          name?: string
          payload?: Json
          scheduled_at?: string | null
          status?: string
          submitted_at?: string | null
          tenant_id?: string
          track_links?: boolean
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "campaign_drafts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      cashback_payments: {
        Row: {
          campaign: string | null
          cashback_amount: number
          created_at: string
          currency: string
          email: string | null
          event_id: string | null
          id: string
          nome: string | null
          paid_at: string
          platform_user_id: string | null
          player_id: string | null
          raw_payload: Json | null
          status: string
          telefone: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          campaign?: string | null
          cashback_amount: number
          created_at?: string
          currency?: string
          email?: string | null
          event_id?: string | null
          id?: string
          nome?: string | null
          paid_at?: string
          platform_user_id?: string | null
          player_id?: string | null
          raw_payload?: Json | null
          status?: string
          telefone?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          campaign?: string | null
          cashback_amount?: number
          created_at?: string
          currency?: string
          email?: string | null
          event_id?: string | null
          id?: string
          nome?: string | null
          paid_at?: string
          platform_user_id?: string | null
          player_id?: string | null
          raw_payload?: Json | null
          status?: string
          telefone?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cashback_payments_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cashback_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_consent_audit: {
        Row: {
          actor_user_id: string | null
          channel: string
          consent_id: string | null
          created_at: string
          id: string
          new_status: string
          previous_status: string | null
          reason: string | null
          source: string | null
          subject: string
          tenant_id: string
        }
        Insert: {
          actor_user_id?: string | null
          channel: string
          consent_id?: string | null
          created_at?: string
          id?: string
          new_status: string
          previous_status?: string | null
          reason?: string | null
          source?: string | null
          subject: string
          tenant_id: string
        }
        Update: {
          actor_user_id?: string | null
          channel?: string
          consent_id?: string | null
          created_at?: string
          id?: string
          new_status?: string
          previous_status?: string | null
          reason?: string | null
          source?: string | null
          subject?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_consent_audit_consent_id_fkey"
            columns: ["consent_id"]
            isOneToOne: false
            referencedRelation: "channel_consents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_consent_audit_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_consents: {
        Row: {
          channel: string
          created_at: string
          id: string
          legal_basis: string | null
          occurred_at: string
          reason: string
          source: string
          status: string
          subject: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          channel: string
          created_at?: string
          id?: string
          legal_basis?: string | null
          occurred_at?: string
          reason?: string
          source?: string
          status: string
          subject: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          channel?: string
          created_at?: string
          id?: string
          legal_basis?: string | null
          occurred_at?: string
          reason?: string
          source?: string
          status?: string
          subject?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_consents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      dashboard_settings: {
        Row: {
          id: string
          reset_at: string
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          id?: string
          reset_at?: string
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          id?: string
          reset_at?: string
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dashboard_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      deposits: {
        Row: {
          completed_at: string | null
          created_at: string
          event_id: string | null
          external_id: string | null
          id: string
          metodo: string | null
          player_id: string | null
          provider_status: string | null
          raw_payload: Json
          status: string
          tenant_id: string
          updated_at: string
          valor: number
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          event_id?: string | null
          external_id?: string | null
          id?: string
          metodo?: string | null
          player_id?: string | null
          provider_status?: string | null
          raw_payload?: Json
          status?: string
          tenant_id?: string
          updated_at?: string
          valor: number
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          event_id?: string | null
          external_id?: string | null
          id?: string
          metodo?: string | null
          player_id?: string | null
          provider_status?: string | null
          raw_payload?: Json
          status?: string
          tenant_id?: string
          updated_at?: string
          valor?: number
        }
        Relationships: [
          {
            foreignKeyName: "deposits_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposits_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      dispatch_pause_state: {
        Row: {
          channel: string
          paused: boolean
          paused_at: string | null
          reason: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          channel: string
          paused?: boolean
          paused_at?: string | null
          reason?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Update: {
          channel?: string
          paused?: boolean
          paused_at?: string | null
          reason?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      dispatch_rate_state: {
        Row: {
          backoff_until: string | null
          channel: string
          last_provider_error: string | null
          max_per_minute: number
          sent_in_window: number
          target_per_minute: number
          updated_at: string
          window_started_at: string
        }
        Insert: {
          backoff_until?: string | null
          channel: string
          last_provider_error?: string | null
          max_per_minute?: number
          sent_in_window?: number
          target_per_minute?: number
          updated_at?: string
          window_started_at?: string
        }
        Update: {
          backoff_until?: string | null
          channel?: string
          last_provider_error?: string | null
          max_per_minute?: number
          sent_in_window?: number
          target_per_minute?: number
          updated_at?: string
          window_started_at?: string
        }
        Relationships: []
      }
      dispatcher_runs: {
        Row: {
          actual_rate: number | null
          channel: string
          claimed: number
          duration_ms: number | null
          errors: number
          finished_at: string | null
          id: number
          kind: string
          last_provider_error: string | null
          lock_recovered: number
          provider: string | null
          queue_before: number
          rate_limited: number
          rescheduled: number
          sent: number
          started_at: string
          stop_reason: string | null
          target_rate: number | null
        }
        Insert: {
          actual_rate?: number | null
          channel: string
          claimed?: number
          duration_ms?: number | null
          errors?: number
          finished_at?: string | null
          id?: number
          kind?: string
          last_provider_error?: string | null
          lock_recovered?: number
          provider?: string | null
          queue_before?: number
          rate_limited?: number
          rescheduled?: number
          sent?: number
          started_at?: string
          stop_reason?: string | null
          target_rate?: number | null
        }
        Update: {
          actual_rate?: number | null
          channel?: string
          claimed?: number
          duration_ms?: number | null
          errors?: number
          finished_at?: string | null
          id?: number
          kind?: string
          last_provider_error?: string | null
          lock_recovered?: number
          provider?: string | null
          queue_before?: number
          rate_limited?: number
          rescheduled?: number
          sent?: number
          started_at?: string
          stop_reason?: string | null
          target_rate?: number | null
        }
        Relationships: []
      }
      email_automations: {
        Row: {
          config: Json
          created_at: string
          delay_minutes: number
          id: string
          is_active: boolean
          name: string
          smtp_id: string | null
          template_id: string | null
          tenant_id: string
          track_links: boolean
          trigger_name: string | null
          updated_at: string
        }
        Insert: {
          config?: Json
          created_at?: string
          delay_minutes?: number
          id?: string
          is_active?: boolean
          name: string
          smtp_id?: string | null
          template_id?: string | null
          tenant_id?: string
          track_links?: boolean
          trigger_name?: string | null
          updated_at?: string
        }
        Update: {
          config?: Json
          created_at?: string
          delay_minutes?: number
          id?: string
          is_active?: boolean
          name?: string
          smtp_id?: string | null
          template_id?: string | null
          tenant_id?: string
          track_links?: boolean
          trigger_name?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_automations_smtp_id_fkey"
            columns: ["smtp_id"]
            isOneToOne: false
            referencedRelation: "email_smtp_configs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_automations_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "email_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_automations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      email_campaigns: {
        Row: {
          audience_filter: Json
          created_at: string
          id: string
          locked_at: string | null
          locked_by: string | null
          name: string
          scheduled_at: string | null
          smtp_id: string | null
          stats: Json
          status: string
          template_id: string | null
          template_snapshot: Json | null
          tenant_id: string
          track_links: boolean
          updated_at: string
        }
        Insert: {
          audience_filter?: Json
          created_at?: string
          id?: string
          locked_at?: string | null
          locked_by?: string | null
          name: string
          scheduled_at?: string | null
          smtp_id?: string | null
          stats?: Json
          status?: string
          template_id?: string | null
          template_snapshot?: Json | null
          tenant_id?: string
          track_links?: boolean
          updated_at?: string
        }
        Update: {
          audience_filter?: Json
          created_at?: string
          id?: string
          locked_at?: string | null
          locked_by?: string | null
          name?: string
          scheduled_at?: string | null
          smtp_id?: string | null
          stats?: Json
          status?: string
          template_id?: string | null
          template_snapshot?: Json | null
          tenant_id?: string
          track_links?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_campaigns_smtp_id_fkey"
            columns: ["smtp_id"]
            isOneToOne: false
            referencedRelation: "email_smtp_configs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_campaigns_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "email_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_campaigns_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      email_flow_blocks: {
        Row: {
          block_type: Database["public"]["Enums"]["email_flow_block_type"]
          condition_type: string | null
          condition_value: string | null
          created_at: string
          delay_seconds: number
          flow_id: string
          id: string
          label: string | null
          order_index: number
          pre_delay_seconds: number
          preheader_override: string | null
          send_at_hour: number | null
          send_at_minute: number
          sender_id: string | null
          skip_if_past: boolean
          smtp_config_id: string | null
          subject_override: string | null
          template_ids: string[]
          tenant_id: string
          track_links: boolean
        }
        Insert: {
          block_type: Database["public"]["Enums"]["email_flow_block_type"]
          condition_type?: string | null
          condition_value?: string | null
          created_at?: string
          delay_seconds?: number
          flow_id: string
          id?: string
          label?: string | null
          order_index?: number
          pre_delay_seconds?: number
          preheader_override?: string | null
          send_at_hour?: number | null
          send_at_minute?: number
          sender_id?: string | null
          skip_if_past?: boolean
          smtp_config_id?: string | null
          subject_override?: string | null
          template_ids?: string[]
          tenant_id?: string
          track_links?: boolean
        }
        Update: {
          block_type?: Database["public"]["Enums"]["email_flow_block_type"]
          condition_type?: string | null
          condition_value?: string | null
          created_at?: string
          delay_seconds?: number
          flow_id?: string
          id?: string
          label?: string | null
          order_index?: number
          pre_delay_seconds?: number
          preheader_override?: string | null
          send_at_hour?: number | null
          send_at_minute?: number
          sender_id?: string | null
          skip_if_past?: boolean
          smtp_config_id?: string | null
          subject_override?: string | null
          template_ids?: string[]
          tenant_id?: string
          track_links?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "email_flow_blocks_flow_id_fkey"
            columns: ["flow_id"]
            isOneToOne: false
            referencedRelation: "email_flows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_flow_blocks_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "email_senders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_flow_blocks_smtp_config_id_fkey"
            columns: ["smtp_config_id"]
            isOneToOne: false
            referencedRelation: "email_smtp_configs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_flow_blocks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      email_flow_leads: {
        Row: {
          attempts: number
          created_at: string
          current_block_index: number
          email: string
          entered_at: string
          exit_reason: string | null
          flow_id: string
          id: string
          last_sent_at: string | null
          last_template_id: string | null
          locked_at: string | null
          locked_by: string | null
          next_run_at: string
          player_id: string | null
          status: Database["public"]["Enums"]["email_flow_lead_status"]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          current_block_index?: number
          email: string
          entered_at?: string
          exit_reason?: string | null
          flow_id: string
          id?: string
          last_sent_at?: string | null
          last_template_id?: string | null
          locked_at?: string | null
          locked_by?: string | null
          next_run_at?: string
          player_id?: string | null
          status?: Database["public"]["Enums"]["email_flow_lead_status"]
          tenant_id?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          current_block_index?: number
          email?: string
          entered_at?: string
          exit_reason?: string | null
          flow_id?: string
          id?: string
          last_sent_at?: string | null
          last_template_id?: string | null
          locked_at?: string | null
          locked_by?: string | null
          next_run_at?: string
          player_id?: string | null
          status?: Database["public"]["Enums"]["email_flow_lead_status"]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_flow_leads_flow_id_fkey"
            columns: ["flow_id"]
            isOneToOne: false
            referencedRelation: "email_flows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_flow_leads_last_template_id_fkey"
            columns: ["last_template_id"]
            isOneToOne: false
            referencedRelation: "email_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_flow_leads_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_flow_leads_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      email_flow_logs: {
        Row: {
          created_at: string
          detail: Json
          event: string
          flow_id: string
          flow_lead_id: string | null
          id: string
          player_id: string | null
          tenant_id: string
        }
        Insert: {
          created_at?: string
          detail?: Json
          event: string
          flow_id: string
          flow_lead_id?: string | null
          id?: string
          player_id?: string | null
          tenant_id?: string
        }
        Update: {
          created_at?: string
          detail?: Json
          event?: string
          flow_id?: string
          flow_lead_id?: string | null
          id?: string
          player_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_flow_logs_flow_id_fkey"
            columns: ["flow_id"]
            isOneToOne: false
            referencedRelation: "email_flows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_flow_logs_flow_lead_id_fkey"
            columns: ["flow_lead_id"]
            isOneToOne: false
            referencedRelation: "email_flow_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_flow_logs_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_flow_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      email_flows: {
        Row: {
          activated_at: string | null
          active: boolean
          cooldown_hours: number
          created_at: string
          daily_limit: number
          exit_conditions: Json
          id: string
          last_run_at: string | null
          name: string
          stats: Json
          tenant_id: string
          trigger_type: Database["public"]["Enums"]["email_trigger_type"]
          updated_at: string
        }
        Insert: {
          activated_at?: string | null
          active?: boolean
          cooldown_hours?: number
          created_at?: string
          daily_limit?: number
          exit_conditions?: Json
          id?: string
          last_run_at?: string | null
          name: string
          stats?: Json
          tenant_id?: string
          trigger_type?: Database["public"]["Enums"]["email_trigger_type"]
          updated_at?: string
        }
        Update: {
          activated_at?: string | null
          active?: boolean
          cooldown_hours?: number
          created_at?: string
          daily_limit?: number
          exit_conditions?: Json
          id?: string
          last_run_at?: string | null
          name?: string
          stats?: Json
          tenant_id?: string
          trigger_type?: Database["public"]["Enums"]["email_trigger_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_flows_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      email_send_logs: {
        Row: {
          automation_id: string | null
          block_index: number | null
          campaign_id: string | null
          created_at: string
          error: string | null
          flow_id: string | null
          flow_lead_id: string | null
          id: string
          player_id: string | null
          provider_response: Json | null
          sent_at: string | null
          status: string
          step_label: string | null
          subject: string | null
          tenant_id: string
          to_email: string
        }
        Insert: {
          automation_id?: string | null
          block_index?: number | null
          campaign_id?: string | null
          created_at?: string
          error?: string | null
          flow_id?: string | null
          flow_lead_id?: string | null
          id?: string
          player_id?: string | null
          provider_response?: Json | null
          sent_at?: string | null
          status?: string
          step_label?: string | null
          subject?: string | null
          tenant_id?: string
          to_email: string
        }
        Update: {
          automation_id?: string | null
          block_index?: number | null
          campaign_id?: string | null
          created_at?: string
          error?: string | null
          flow_id?: string | null
          flow_lead_id?: string | null
          id?: string
          player_id?: string | null
          provider_response?: Json | null
          sent_at?: string | null
          status?: string
          step_label?: string | null
          subject?: string | null
          tenant_id?: string
          to_email?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_send_logs_automation_id_fkey"
            columns: ["automation_id"]
            isOneToOne: false
            referencedRelation: "email_automations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_send_logs_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "email_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_send_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      email_senders: {
        Row: {
          created_at: string
          domain: string | null
          from_email: string
          from_name: string | null
          id: string
          is_default: boolean
          name: string
          reply_to: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          domain?: string | null
          from_email: string
          from_name?: string | null
          id?: string
          is_default?: boolean
          name: string
          reply_to?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          domain?: string | null
          from_email?: string
          from_name?: string | null
          id?: string
          is_default?: boolean
          name?: string
          reply_to?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_senders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      email_smtp_configs: {
        Row: {
          config: Json
          created_at: string
          from_email: string
          from_name: string | null
          host: string
          id: string
          is_default: boolean
          last_test_error: string | null
          last_test_ok: boolean | null
          last_tested_at: string | null
          name: string
          password_encrypted: string | null
          port: number
          secure: boolean
          status: string
          tenant_id: string
          updated_at: string
          username: string | null
        }
        Insert: {
          config?: Json
          created_at?: string
          from_email: string
          from_name?: string | null
          host: string
          id?: string
          is_default?: boolean
          last_test_error?: string | null
          last_test_ok?: boolean | null
          last_tested_at?: string | null
          name: string
          password_encrypted?: string | null
          port?: number
          secure?: boolean
          status?: string
          tenant_id?: string
          updated_at?: string
          username?: string | null
        }
        Update: {
          config?: Json
          created_at?: string
          from_email?: string
          from_name?: string | null
          host?: string
          id?: string
          is_default?: boolean
          last_test_error?: string | null
          last_test_ok?: boolean | null
          last_tested_at?: string | null
          name?: string
          password_encrypted?: string | null
          port?: number
          secure?: boolean
          status?: string
          tenant_id?: string
          updated_at?: string
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_smtp_configs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      email_template_versions: {
        Row: {
          body_html: string
          body_text: string
          changed_by: string | null
          created_at: string
          from_name: string | null
          id: string
          lifecycle_status: string
          name: string
          preheader: string | null
          subject: string
          tags: string[]
          template_id: string
          tenant_id: string
          track_links: boolean
          version: number
        }
        Insert: {
          body_html: string
          body_text?: string
          changed_by?: string | null
          created_at?: string
          from_name?: string | null
          id?: string
          lifecycle_status: string
          name: string
          preheader?: string | null
          subject: string
          tags?: string[]
          template_id: string
          tenant_id: string
          track_links?: boolean
          version: number
        }
        Update: {
          body_html?: string
          body_text?: string
          changed_by?: string | null
          created_at?: string
          from_name?: string | null
          id?: string
          lifecycle_status?: string
          name?: string
          preheader?: string | null
          subject?: string
          tags?: string[]
          template_id?: string
          tenant_id?: string
          track_links?: boolean
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "email_template_versions_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "email_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_template_versions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      email_templates: {
        Row: {
          body_html: string
          body_text: string
          created_at: string
          from_name: string | null
          id: string
          is_active: boolean
          lifecycle_status: string
          name: string
          preheader: string | null
          published_at: string | null
          subject: string
          tags: string[]
          tenant_id: string
          track_links: boolean
          updated_at: string
          version: number
        }
        Insert: {
          body_html?: string
          body_text?: string
          created_at?: string
          from_name?: string | null
          id?: string
          is_active?: boolean
          lifecycle_status?: string
          name: string
          preheader?: string | null
          published_at?: string | null
          subject: string
          tags?: string[]
          tenant_id?: string
          track_links?: boolean
          updated_at?: string
          version?: number
        }
        Update: {
          body_html?: string
          body_text?: string
          created_at?: string
          from_name?: string | null
          id?: string
          is_active?: boolean
          lifecycle_status?: string
          name?: string
          preheader?: string | null
          published_at?: string | null
          subject?: string
          tags?: string[]
          tenant_id?: string
          track_links?: boolean
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "email_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      email_unsubscribe_tokens: {
        Row: {
          created_at: string
          email: string
          id: string
          tenant_id: string | null
          token: string
          used_at: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          tenant_id?: string | null
          token: string
          used_at?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          tenant_id?: string | null
          token?: string
          used_at?: string | null
        }
        Relationships: []
      }
      events: {
        Row: {
          created_at: string
          id: string
          metadata: Json
          player_id: string | null
          provider_event_id: string | null
          tenant_id: string
          tipo: string
          valor: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          metadata?: Json
          player_id?: string | null
          provider_event_id?: string | null
          tenant_id?: string
          tipo: string
          valor?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          metadata?: Json
          player_id?: string | null
          provider_event_id?: string | null
          tenant_id?: string
          tipo?: string
          valor?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "events_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      experts: {
        Row: {
          affiliate_id: string
          created_at: string
          id: string
          nome: string
          tenant_id: string
        }
        Insert: {
          affiliate_id: string
          created_at?: string
          id?: string
          nome: string
          tenant_id?: string
        }
        Update: {
          affiliate_id?: string
          created_at?: string
          id?: string
          nome?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "experts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      financial_webhook_attempts: {
        Row: {
          completed_at: string | null
          created_at: string
          error_message: string | null
          event_name: string
          id: string
          normalized_event: Json
          parser_version: string
          provider_event_id: string | null
          raw_payload: Json
          status: string
          tenant_id: string
          updated_at: string
          webhook_log_id: string | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          event_name: string
          id?: string
          normalized_event: Json
          parser_version: string
          provider_event_id?: string | null
          raw_payload: Json
          status?: string
          tenant_id: string
          updated_at?: string
          webhook_log_id?: string | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          event_name?: string
          id?: string
          normalized_event?: Json
          parser_version?: string
          provider_event_id?: string | null
          raw_payload?: Json
          status?: string
          tenant_id?: string
          updated_at?: string
          webhook_log_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "financial_webhook_attempts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "financial_webhook_attempts_webhook_log_id_fkey"
            columns: ["webhook_log_id"]
            isOneToOne: false
            referencedRelation: "webhook_logs"
            referencedColumns: ["id"]
          },
        ]
      }
      flow_blocks: {
        Row: {
          block_type: Database["public"]["Enums"]["flow_block_type"]
          caption: string | null
          content: string | null
          created_at: string
          delay_seconds: number
          flow_id: string
          flow_template_id: string | null
          id: string
          media_filename: string | null
          media_mimetype: string | null
          media_url: string | null
          order_index: number
          tenant_id: string
        }
        Insert: {
          block_type: Database["public"]["Enums"]["flow_block_type"]
          caption?: string | null
          content?: string | null
          created_at?: string
          delay_seconds?: number
          flow_id: string
          flow_template_id?: string | null
          id?: string
          media_filename?: string | null
          media_mimetype?: string | null
          media_url?: string | null
          order_index?: number
          tenant_id?: string
        }
        Update: {
          block_type?: Database["public"]["Enums"]["flow_block_type"]
          caption?: string | null
          content?: string | null
          created_at?: string
          delay_seconds?: number
          flow_id?: string
          flow_template_id?: string | null
          id?: string
          media_filename?: string | null
          media_mimetype?: string | null
          media_url?: string | null
          order_index?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "flow_blocks_flow_id_fkey"
            columns: ["flow_id"]
            isOneToOne: false
            referencedRelation: "flows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flow_blocks_flow_template_id_fkey"
            columns: ["flow_template_id"]
            isOneToOne: false
            referencedRelation: "flow_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flow_blocks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      flow_leads: {
        Row: {
          attempt_count: number
          completed_at: string | null
          current_block_index: number
          exit_reason: string | null
          flow_id: string
          id: string
          last_error: string | null
          next_run_at: string
          phone_e164: string
          player_id: string | null
          session_id: string | null
          started_at: string
          status: Database["public"]["Enums"]["flow_lead_status"]
          template_id: string | null
          tenant_id: string
        }
        Insert: {
          attempt_count?: number
          completed_at?: string | null
          current_block_index?: number
          exit_reason?: string | null
          flow_id: string
          id?: string
          last_error?: string | null
          next_run_at?: string
          phone_e164: string
          player_id?: string | null
          session_id?: string | null
          started_at?: string
          status?: Database["public"]["Enums"]["flow_lead_status"]
          template_id?: string | null
          tenant_id?: string
        }
        Update: {
          attempt_count?: number
          completed_at?: string | null
          current_block_index?: number
          exit_reason?: string | null
          flow_id?: string
          id?: string
          last_error?: string | null
          next_run_at?: string
          phone_e164?: string
          player_id?: string | null
          session_id?: string | null
          started_at?: string
          status?: Database["public"]["Enums"]["flow_lead_status"]
          template_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "flow_leads_flow_id_fkey"
            columns: ["flow_id"]
            isOneToOne: false
            referencedRelation: "flows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flow_leads_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "flow_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flow_leads_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      flow_logs: {
        Row: {
          block_id: string | null
          created_at: string
          detail: Json
          event: string
          flow_id: string | null
          flow_lead_id: string | null
          id: string
          player_id: string | null
          session_id: string | null
          tenant_id: string
        }
        Insert: {
          block_id?: string | null
          created_at?: string
          detail?: Json
          event: string
          flow_id?: string | null
          flow_lead_id?: string | null
          id?: string
          player_id?: string | null
          session_id?: string | null
          tenant_id?: string
        }
        Update: {
          block_id?: string | null
          created_at?: string
          detail?: Json
          event?: string
          flow_id?: string | null
          flow_lead_id?: string | null
          id?: string
          player_id?: string | null
          session_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "flow_logs_block_id_fkey"
            columns: ["block_id"]
            isOneToOne: false
            referencedRelation: "flow_blocks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flow_logs_flow_id_fkey"
            columns: ["flow_id"]
            isOneToOne: false
            referencedRelation: "flows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flow_logs_flow_lead_id_fkey"
            columns: ["flow_lead_id"]
            isOneToOne: false
            referencedRelation: "flow_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flow_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      flow_templates: {
        Row: {
          created_at: string
          flow_id: string
          id: string
          is_active: boolean
          name: string
          tenant_id: string
          updated_at: string
          weight: number
        }
        Insert: {
          created_at?: string
          flow_id: string
          id?: string
          is_active?: boolean
          name?: string
          tenant_id?: string
          updated_at?: string
          weight?: number
        }
        Update: {
          created_at?: string
          flow_id?: string
          id?: string
          is_active?: boolean
          name?: string
          tenant_id?: string
          updated_at?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "flow_templates_flow_id_fkey"
            columns: ["flow_id"]
            isOneToOne: false
            referencedRelation: "flows"
            referencedColumns: ["id"]
          },
        ]
      }
      flows: {
        Row: {
          activated_at: string | null
          active: boolean
          cooldown_hours: number
          created_at: string
          daily_limit: number
          delay_max_seconds: number
          delay_min_seconds: number
          exit_conditions: Json
          hourly_limit: number
          id: string
          name: string
          priority: Database["public"]["Enums"]["flow_priority"]
          stats: Json
          tenant_id: string
          trigger_type: Database["public"]["Enums"]["flow_trigger_type"]
          updated_at: string
        }
        Insert: {
          activated_at?: string | null
          active?: boolean
          cooldown_hours?: number
          created_at?: string
          daily_limit?: number
          delay_max_seconds?: number
          delay_min_seconds?: number
          exit_conditions?: Json
          hourly_limit?: number
          id?: string
          name: string
          priority?: Database["public"]["Enums"]["flow_priority"]
          stats?: Json
          tenant_id?: string
          trigger_type: Database["public"]["Enums"]["flow_trigger_type"]
          updated_at?: string
        }
        Update: {
          activated_at?: string | null
          active?: boolean
          cooldown_hours?: number
          created_at?: string
          daily_limit?: number
          delay_max_seconds?: number
          delay_min_seconds?: number
          exit_conditions?: Json
          hourly_limit?: number
          id?: string
          name?: string
          priority?: Database["public"]["Enums"]["flow_priority"]
          stats?: Json
          tenant_id?: string
          trigger_type?: Database["public"]["Enums"]["flow_trigger_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "flows_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      gamification_settings: {
        Row: {
          cooling_after_days: number
          created_at: string
          level_thresholds: Json
          sleeping_after_days: number
          tenant_id: string
          updated_at: string
          updated_by: string | null
          vip_min_level: string
        }
        Insert: {
          cooling_after_days?: number
          created_at?: string
          level_thresholds?: Json
          sleeping_after_days?: number
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
          vip_min_level?: string
        }
        Update: {
          cooling_after_days?: number
          created_at?: string
          level_thresholds?: Json
          sleeping_after_days?: number
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
          vip_min_level?: string
        }
        Relationships: [
          {
            foreignKeyName: "gamification_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      journey_enrollments: {
        Row: {
          attempts: number
          claimed_at: string | null
          claimed_by: string | null
          completed_at: string | null
          created_at: string
          current_position: number
          entered_at: string
          entry_key: string
          exit_reason: string | null
          exited_at: string | null
          id: string
          journey_id: string
          journey_version: number
          metadata: Json
          next_run_at: string
          player_id: string | null
          status: Database["public"]["Enums"]["journey_enrollment_status"]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          claimed_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          created_at?: string
          current_position?: number
          entered_at?: string
          entry_key?: string
          exit_reason?: string | null
          exited_at?: string | null
          id?: string
          journey_id: string
          journey_version: number
          metadata?: Json
          next_run_at?: string
          player_id?: string | null
          status?: Database["public"]["Enums"]["journey_enrollment_status"]
          tenant_id: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          claimed_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          created_at?: string
          current_position?: number
          entered_at?: string
          entry_key?: string
          exit_reason?: string | null
          exited_at?: string | null
          id?: string
          journey_id?: string
          journey_version?: number
          metadata?: Json
          next_run_at?: string
          player_id?: string | null
          status?: Database["public"]["Enums"]["journey_enrollment_status"]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "journey_enrollments_journey_id_fkey"
            columns: ["journey_id"]
            isOneToOne: false
            referencedRelation: "journeys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journey_enrollments_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journey_enrollments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      journey_events: {
        Row: {
          actor_user_id: string | null
          created_at: string
          detail: Json
          enrollment_id: string | null
          event_type: string
          execution_id: string | null
          id: string
          journey_id: string
          tenant_id: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          detail?: Json
          enrollment_id?: string | null
          event_type: string
          execution_id?: string | null
          id?: string
          journey_id: string
          tenant_id: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          detail?: Json
          enrollment_id?: string | null
          event_type?: string
          execution_id?: string | null
          id?: string
          journey_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "journey_events_enrollment_id_fkey"
            columns: ["enrollment_id"]
            isOneToOne: false
            referencedRelation: "journey_enrollments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journey_events_execution_id_fkey"
            columns: ["execution_id"]
            isOneToOne: false
            referencedRelation: "journey_step_executions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journey_events_journey_id_fkey"
            columns: ["journey_id"]
            isOneToOne: false
            referencedRelation: "journeys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journey_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      journey_step_executions: {
        Row: {
          attempt: number
          channel: string | null
          completed_at: string | null
          created_at: string
          enrollment_id: string
          error: string | null
          executed_at: string | null
          id: string
          idempotency_key: string
          journey_id: string
          provider: string | null
          provider_message_id: string | null
          provider_response: Json | null
          scheduled_at: string
          status: Database["public"]["Enums"]["journey_execution_status"]
          step_id: string | null
          step_position: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          attempt?: number
          channel?: string | null
          completed_at?: string | null
          created_at?: string
          enrollment_id: string
          error?: string | null
          executed_at?: string | null
          id?: string
          idempotency_key?: string
          journey_id: string
          provider?: string | null
          provider_message_id?: string | null
          provider_response?: Json | null
          scheduled_at?: string
          status?: Database["public"]["Enums"]["journey_execution_status"]
          step_id?: string | null
          step_position: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          attempt?: number
          channel?: string | null
          completed_at?: string | null
          created_at?: string
          enrollment_id?: string
          error?: string | null
          executed_at?: string | null
          id?: string
          idempotency_key?: string
          journey_id?: string
          provider?: string | null
          provider_message_id?: string | null
          provider_response?: Json | null
          scheduled_at?: string
          status?: Database["public"]["Enums"]["journey_execution_status"]
          step_id?: string | null
          step_position?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "journey_step_executions_enrollment_id_fkey"
            columns: ["enrollment_id"]
            isOneToOne: false
            referencedRelation: "journey_enrollments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journey_step_executions_journey_id_fkey"
            columns: ["journey_id"]
            isOneToOne: false
            referencedRelation: "journeys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journey_step_executions_step_id_fkey"
            columns: ["step_id"]
            isOneToOne: false
            referencedRelation: "journey_steps"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journey_step_executions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      journey_steps: {
        Row: {
          config: Json
          created_at: string
          id: string
          is_enabled: boolean
          journey_id: string
          label: string | null
          position: number
          step_type: Database["public"]["Enums"]["journey_step_type"]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          config?: Json
          created_at?: string
          id?: string
          is_enabled?: boolean
          journey_id: string
          label?: string | null
          position: number
          step_type: Database["public"]["Enums"]["journey_step_type"]
          tenant_id: string
          updated_at?: string
        }
        Update: {
          config?: Json
          created_at?: string
          id?: string
          is_enabled?: boolean
          journey_id?: string
          label?: string | null
          position?: number
          step_type?: Database["public"]["Enums"]["journey_step_type"]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "journey_steps_journey_id_fkey"
            columns: ["journey_id"]
            isOneToOne: false
            referencedRelation: "journeys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journey_steps_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      journey_voice_assets: {
        Row: {
          archived_at: string | null
          content_type: string
          created_at: string
          duration_seconds: number | null
          id: string
          is_archived: boolean
          language: string
          name: string
          size_bytes: number
          source: string
          storage_path: string
          tags: string[]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          content_type: string
          created_at?: string
          duration_seconds?: number | null
          id?: string
          is_archived?: boolean
          language?: string
          name: string
          size_bytes: number
          source?: string
          storage_path: string
          tags?: string[]
          tenant_id: string
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          content_type?: string
          created_at?: string
          duration_seconds?: number | null
          id?: string
          is_archived?: boolean
          language?: string
          name?: string
          size_bytes?: number
          source?: string
          storage_path?: string
          tags?: string[]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "journey_voice_assets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      journeys: {
        Row: {
          activated_at: string | null
          approved_by: string | null
          archived_at: string | null
          cooldown_hours: number
          created_at: string
          created_by: string | null
          daily_limit: number
          description: string | null
          entry_rules: Json
          exit_rules: Json
          id: string
          legacy_migrated_at: string | null
          legacy_source_id: string | null
          legacy_source_type: string | null
          name: string
          paused_at: string | null
          published_version: number | null
          revision_of: string | null
          status: Database["public"]["Enums"]["journey_status"]
          tenant_id: string
          timezone: string
          trigger_config: Json
          trigger_type: string
          updated_at: string
          version: number
        }
        Insert: {
          activated_at?: string | null
          approved_by?: string | null
          archived_at?: string | null
          cooldown_hours?: number
          created_at?: string
          created_by?: string | null
          daily_limit?: number
          description?: string | null
          entry_rules?: Json
          exit_rules?: Json
          id?: string
          legacy_migrated_at?: string | null
          legacy_source_id?: string | null
          legacy_source_type?: string | null
          name: string
          paused_at?: string | null
          published_version?: number | null
          revision_of?: string | null
          status?: Database["public"]["Enums"]["journey_status"]
          tenant_id: string
          timezone?: string
          trigger_config?: Json
          trigger_type?: string
          updated_at?: string
          version?: number
        }
        Update: {
          activated_at?: string | null
          approved_by?: string | null
          archived_at?: string | null
          cooldown_hours?: number
          created_at?: string
          created_by?: string | null
          daily_limit?: number
          description?: string | null
          entry_rules?: Json
          exit_rules?: Json
          id?: string
          legacy_migrated_at?: string | null
          legacy_source_id?: string | null
          legacy_source_type?: string | null
          name?: string
          paused_at?: string | null
          published_version?: number | null
          revision_of?: string | null
          status?: Database["public"]["Enums"]["journey_status"]
          tenant_id?: string
          timezone?: string
          trigger_config?: Json
          trigger_type?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "journeys_revision_of_fkey"
            columns: ["revision_of"]
            isOneToOne: false
            referencedRelation: "journeys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journeys_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_alerts: {
        Row: {
          fired_at: string
          flow_lead_id: string | null
          id: string
          payload: Json
          player_id: string
          rule_id: string | null
          tenant_id: string
          trigger_type: Database["public"]["Enums"]["flow_trigger_type"]
        }
        Insert: {
          fired_at?: string
          flow_lead_id?: string | null
          id?: string
          payload?: Json
          player_id: string
          rule_id?: string | null
          tenant_id?: string
          trigger_type: Database["public"]["Enums"]["flow_trigger_type"]
        }
        Update: {
          fired_at?: string
          flow_lead_id?: string | null
          id?: string
          payload?: Json
          player_id?: string
          rule_id?: string | null
          tenant_id?: string
          trigger_type?: Database["public"]["Enums"]["flow_trigger_type"]
        }
        Relationships: [
          {
            foreignKeyName: "lead_alerts_flow_lead_id_fkey"
            columns: ["flow_lead_id"]
            isOneToOne: false
            referencedRelation: "flow_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_alerts_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_alerts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_followups: {
        Row: {
          acao: Database["public"]["Enums"]["followup_acao"]
          alerta_tipo: string
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          player_id: string
          tenant_id: string
        }
        Insert: {
          acao: Database["public"]["Enums"]["followup_acao"]
          alerta_tipo: string
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          player_id: string
          tenant_id?: string
        }
        Update: {
          acao?: Database["public"]["Enums"]["followup_acao"]
          alerta_tipo?: string
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          player_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_followups_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_whatsapp_assignments: {
        Row: {
          assigned_at: string
          id: string
          phone_e164: string
          player_id: string | null
          previous_session_ids: string[]
          session_id: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          assigned_at?: string
          id?: string
          phone_e164: string
          player_id?: string | null
          previous_session_ids?: string[]
          session_id: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Update: {
          assigned_at?: string
          id?: string
          phone_e164?: string
          player_id?: string | null
          previous_session_ids?: string[]
          session_id?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_whatsapp_assignments_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_whatsapp_assignments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      link_click_snapshots: {
        Row: {
          clicks: number
          created_at: string
          human_clicks: number | null
          id: string
          payload: Json
          snapshot_at: string
          tenant_id: string
          tracked_link_id: string
        }
        Insert: {
          clicks?: number
          created_at?: string
          human_clicks?: number | null
          id?: string
          payload?: Json
          snapshot_at: string
          tenant_id: string
          tracked_link_id: string
        }
        Update: {
          clicks?: number
          created_at?: string
          human_clicks?: number | null
          id?: string
          payload?: Json
          snapshot_at?: string
          tenant_id?: string
          tracked_link_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "link_click_snapshots_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "link_click_snapshots_tracked_link_id_fkey"
            columns: ["tracked_link_id"]
            isOneToOne: false
            referencedRelation: "tracked_links"
            referencedColumns: ["id"]
          },
        ]
      }
      link_dispatches: {
        Row: {
          channel: string
          created_at: string
          id: string
          idempotency_key: string
          message_log_id: string | null
          message_log_type: string | null
          original_url: string
          recipient_hash: string | null
          recipient_player_id: string | null
          send_status: string
          sent_at: string | null
          sent_url: string
          source_id: string | null
          source_type: string
          tenant_id: string
          tracked_link_id: string
          tracking_token: string
          updated_at: string
          url_position: number
        }
        Insert: {
          channel: string
          created_at?: string
          id?: string
          idempotency_key: string
          message_log_id?: string | null
          message_log_type?: string | null
          original_url: string
          recipient_hash?: string | null
          recipient_player_id?: string | null
          send_status?: string
          sent_at?: string | null
          sent_url: string
          source_id?: string | null
          source_type: string
          tenant_id: string
          tracked_link_id: string
          tracking_token?: string
          updated_at?: string
          url_position?: number
        }
        Update: {
          channel?: string
          created_at?: string
          id?: string
          idempotency_key?: string
          message_log_id?: string | null
          message_log_type?: string | null
          original_url?: string
          recipient_hash?: string | null
          recipient_player_id?: string | null
          send_status?: string
          sent_at?: string | null
          sent_url?: string
          source_id?: string | null
          source_type?: string
          tenant_id?: string
          tracked_link_id?: string
          tracking_token?: string
          updated_at?: string
          url_position?: number
        }
        Relationships: [
          {
            foreignKeyName: "link_dispatches_recipient_player_id_fkey"
            columns: ["recipient_player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "link_dispatches_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "link_dispatches_tracked_link_id_fkey"
            columns: ["tracked_link_id"]
            isOneToOne: false
            referencedRelation: "tracked_links"
            referencedColumns: ["id"]
          },
        ]
      }
      link_tracking_sync_runs: {
        Row: {
          created_at: string
          cursor: string | null
          error: string | null
          finished_at: string | null
          id: string
          links_processed: number
          started_at: string
          status: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          cursor?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          links_processed?: number
          started_at?: string
          status?: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          cursor?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          links_processed?: number
          started_at?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "link_tracking_sync_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_ad_metrics_daily: {
        Row: {
          ad_account_id: string | null
          ad_id: string | null
          ad_name: string | null
          adset_id: string | null
          adset_name: string | null
          campaign_id: string | null
          campaign_name: string | null
          clicks: number
          cpc: number | null
          cpm: number | null
          created_at: string
          creative_name: string | null
          ctr: number | null
          id: string
          imported_at: string
          impressions: number
          metric_date: string
          provider: string
          raw: Json
          spend: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          ad_account_id?: string | null
          ad_id?: string | null
          ad_name?: string | null
          adset_id?: string | null
          adset_name?: string | null
          campaign_id?: string | null
          campaign_name?: string | null
          clicks?: number
          cpc?: number | null
          cpm?: number | null
          created_at?: string
          creative_name?: string | null
          ctr?: number | null
          id?: string
          imported_at?: string
          impressions?: number
          metric_date: string
          provider: string
          raw?: Json
          spend?: number
          tenant_id?: string
          updated_at?: string
        }
        Update: {
          ad_account_id?: string | null
          ad_id?: string | null
          ad_name?: string | null
          adset_id?: string | null
          adset_name?: string | null
          campaign_id?: string | null
          campaign_name?: string | null
          clicks?: number
          cpc?: number | null
          cpm?: number | null
          created_at?: string
          creative_name?: string | null
          ctr?: number | null
          id?: string
          imported_at?: string
          impressions?: number
          metric_date?: string
          provider?: string
          raw?: Json
          spend?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketing_ad_metrics_daily_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_integrations: {
        Row: {
          account_name: string | null
          connected_at: string | null
          created_at: string
          currency: string
          external_account_id: string | null
          id: string
          last_sync_at: string | null
          provider: string
          settings: Json
          status: string
          tenant_id: string
          token_expires_at: string | null
          updated_at: string
        }
        Insert: {
          account_name?: string | null
          connected_at?: string | null
          created_at?: string
          currency?: string
          external_account_id?: string | null
          id?: string
          last_sync_at?: string | null
          provider: string
          settings?: Json
          status?: string
          tenant_id?: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          account_name?: string | null
          connected_at?: string | null
          created_at?: string
          currency?: string
          external_account_id?: string | null
          id?: string
          last_sync_at?: string | null
          provider?: string
          settings?: Json
          status?: string
          tenant_id?: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketing_integrations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      meta_ad_accounts: {
        Row: {
          account_id: string | null
          account_status: number | null
          business_id: string | null
          business_name: string | null
          connection_id: string
          created_at: string
          currency: string | null
          id: string
          last_attempt_at: string | null
          last_error: string | null
          last_row_count: number
          last_success_at: string | null
          last_sync_at: string | null
          meta_ad_account_id: string
          name: string | null
          raw: Json
          selected: boolean
          sync_status: string
          tenant_id: string
          timezone_name: string | null
          updated_at: string
        }
        Insert: {
          account_id?: string | null
          account_status?: number | null
          business_id?: string | null
          business_name?: string | null
          connection_id: string
          created_at?: string
          currency?: string | null
          id?: string
          last_attempt_at?: string | null
          last_error?: string | null
          last_row_count?: number
          last_success_at?: string | null
          last_sync_at?: string | null
          meta_ad_account_id: string
          name?: string | null
          raw?: Json
          selected?: boolean
          sync_status?: string
          tenant_id: string
          timezone_name?: string | null
          updated_at?: string
        }
        Update: {
          account_id?: string | null
          account_status?: number | null
          business_id?: string | null
          business_name?: string | null
          connection_id?: string
          created_at?: string
          currency?: string | null
          id?: string
          last_attempt_at?: string | null
          last_error?: string | null
          last_row_count?: number
          last_success_at?: string | null
          last_sync_at?: string | null
          meta_ad_account_id?: string
          name?: string | null
          raw?: Json
          selected?: boolean
          sync_status?: string
          tenant_id?: string
          timezone_name?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meta_ad_accounts_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "meta_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meta_ad_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      meta_connection_audit: {
        Row: {
          action: string
          actor_user_id: string | null
          connection_id: string | null
          created_at: string
          id: string
          metadata: Json
          tenant_id: string
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          connection_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          tenant_id: string
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          connection_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "meta_connection_audit_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "meta_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meta_connection_audit_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      meta_connections: {
        Row: {
          access_token: string | null
          app_id: string | null
          app_name: string | null
          auth_type: string
          business_id: string | null
          connected_at: string
          connected_by_user_id: string
          connection_label: string | null
          created_at: string
          data_access_expires_at: string | null
          disabled_at: string | null
          disabled_by_user_id: string | null
          encrypted_access_token: string | null
          id: string
          last_error: string | null
          last_sync_at: string | null
          meta_user_id: string
          meta_user_name: string | null
          permissions_checked_at: string | null
          scopes: string[]
          status: string
          tenant_id: string
          token_expires_at: string | null
          token_hint: string | null
          token_validated_at: string | null
          updated_at: string
        }
        Insert: {
          access_token?: string | null
          app_id?: string | null
          app_name?: string | null
          auth_type?: string
          business_id?: string | null
          connected_at?: string
          connected_by_user_id: string
          connection_label?: string | null
          created_at?: string
          data_access_expires_at?: string | null
          disabled_at?: string | null
          disabled_by_user_id?: string | null
          encrypted_access_token?: string | null
          id?: string
          last_error?: string | null
          last_sync_at?: string | null
          meta_user_id: string
          meta_user_name?: string | null
          permissions_checked_at?: string | null
          scopes?: string[]
          status?: string
          tenant_id: string
          token_expires_at?: string | null
          token_hint?: string | null
          token_validated_at?: string | null
          updated_at?: string
        }
        Update: {
          access_token?: string | null
          app_id?: string | null
          app_name?: string | null
          auth_type?: string
          business_id?: string | null
          connected_at?: string
          connected_by_user_id?: string
          connection_label?: string | null
          created_at?: string
          data_access_expires_at?: string | null
          disabled_at?: string | null
          disabled_by_user_id?: string | null
          encrypted_access_token?: string | null
          id?: string
          last_error?: string | null
          last_sync_at?: string | null
          meta_user_id?: string
          meta_user_name?: string | null
          permissions_checked_at?: string | null
          scopes?: string[]
          status?: string
          tenant_id?: string
          token_expires_at?: string | null
          token_hint?: string | null
          token_validated_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meta_connections_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      meta_oauth_states: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          nonce: string
          return_to: string | null
          tenant_id: string
          used_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          nonce: string
          return_to?: string | null
          tenant_id: string
          used_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          nonce?: string
          return_to?: string | null
          tenant_id?: string
          used_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "meta_oauth_states_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      meta_sync_jobs: {
        Row: {
          account_id: string
          attempt_count: number
          created_at: string
          days: number
          finished_at: string | null
          id: string
          last_error: string | null
          locked_at: string | null
          max_attempts: number
          next_attempt_at: string
          rows_imported: number
          run_id: string
          started_at: string | null
          status: string
          tenant_id: string
          updated_at: string
          worker_id: string | null
        }
        Insert: {
          account_id: string
          attempt_count?: number
          created_at?: string
          days: number
          finished_at?: string | null
          id?: string
          last_error?: string | null
          locked_at?: string | null
          max_attempts?: number
          next_attempt_at?: string
          rows_imported?: number
          run_id: string
          started_at?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
          worker_id?: string | null
        }
        Update: {
          account_id?: string
          attempt_count?: number
          created_at?: string
          days?: number
          finished_at?: string | null
          id?: string
          last_error?: string | null
          locked_at?: string | null
          max_attempts?: number
          next_attempt_at?: string
          rows_imported?: number
          run_id?: string
          started_at?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "meta_sync_jobs_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "meta_ad_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meta_sync_jobs_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "meta_sync_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meta_sync_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      meta_sync_runs: {
        Row: {
          created_at: string
          days: number
          error_summary: string | null
          failed_accounts: number
          finished_at: string | null
          id: string
          processed_accounts: number
          requested_by_user_id: string | null
          rows_imported: number
          started_at: string | null
          status: string
          successful_accounts: number
          tenant_id: string
          total_accounts: number
          trigger_type: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          days?: number
          error_summary?: string | null
          failed_accounts?: number
          finished_at?: string | null
          id?: string
          processed_accounts?: number
          requested_by_user_id?: string | null
          rows_imported?: number
          started_at?: string | null
          status?: string
          successful_accounts?: number
          tenant_id: string
          total_accounts?: number
          trigger_type?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          days?: number
          error_summary?: string | null
          failed_accounts?: number
          finished_at?: string | null
          id?: string
          processed_accounts?: number
          requested_by_user_id?: string | null
          rows_imported?: number
          started_at?: string | null
          status?: string
          successful_accounts?: number
          tenant_id?: string
          total_accounts?: number
          trigger_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meta_sync_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_pricing: {
        Row: {
          channel: string
          id: string
          price_per_unit: number
          unit_label: string
          updated_at: string
        }
        Insert: {
          channel: string
          id?: string
          price_per_unit?: number
          unit_label?: string
          updated_at?: string
        }
        Update: {
          channel?: string
          id?: string
          price_per_unit?: number
          unit_label?: string
          updated_at?: string
        }
        Relationships: []
      }
      player_attributions: {
        Row: {
          captured_at: string
          created_at: string
          event_id: string | null
          event_type: string
          fbclid: string | null
          gbraid: string | null
          gclid: string | null
          id: string
          match_confidence: number
          match_status: string
          matched_ad_account_id: string | null
          matched_ad_id: string | null
          matched_adset_id: string | null
          matched_campaign_id: string | null
          msclkid: string | null
          player_id: string
          provider: string | null
          raw_payload: Json
          tenant_id: string
          trackgram_click_id: string | null
          ttclid: string | null
          updated_at: string
          utm_campaign: string | null
          utm_content: string | null
          utm_id: string | null
          utm_medium: string | null
          utm_source: string | null
          utm_term: string | null
          wbraid: string | null
        }
        Insert: {
          captured_at?: string
          created_at?: string
          event_id?: string | null
          event_type?: string
          fbclid?: string | null
          gbraid?: string | null
          gclid?: string | null
          id?: string
          match_confidence?: number
          match_status?: string
          matched_ad_account_id?: string | null
          matched_ad_id?: string | null
          matched_adset_id?: string | null
          matched_campaign_id?: string | null
          msclkid?: string | null
          player_id: string
          provider?: string | null
          raw_payload?: Json
          tenant_id?: string
          trackgram_click_id?: string | null
          ttclid?: string | null
          updated_at?: string
          utm_campaign?: string | null
          utm_content?: string | null
          utm_id?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          utm_term?: string | null
          wbraid?: string | null
        }
        Update: {
          captured_at?: string
          created_at?: string
          event_id?: string | null
          event_type?: string
          fbclid?: string | null
          gbraid?: string | null
          gclid?: string | null
          id?: string
          match_confidence?: number
          match_status?: string
          matched_ad_account_id?: string | null
          matched_ad_id?: string | null
          matched_adset_id?: string | null
          matched_campaign_id?: string | null
          msclkid?: string | null
          player_id?: string
          provider?: string | null
          raw_payload?: Json
          tenant_id?: string
          trackgram_click_id?: string | null
          ttclid?: string | null
          updated_at?: string
          utm_campaign?: string | null
          utm_content?: string | null
          utm_id?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          utm_term?: string | null
          wbraid?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "player_attributions_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "player_attributions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      players: {
        Row: {
          affiliate_id: string | null
          cpf: string | null
          created_at: string
          data_nascimento: string | null
          email: string | null
          expert: string | null
          ftd_em: string | null
          id: string
          last_cashback_amount: number | null
          last_cashback_paid_at: string | null
          last_cashback_sms_template_sent: number
          nome: string
          origem: string | null
          pais: string | null
          player_external_id: string | null
          risco: string
          saldo_bloqueado: number
          saldo_bonus: number
          saldo_carteira: number
          status: string
          tags: string[]
          telefone: string | null
          tenant_id: string
          total_apostado: number
          total_cashback_paid: number
          total_depositado: number
          total_sacado: number
          ultimo_deposito: string | null
          ultimo_jogo: string | null
          ultimo_login: string | null
          ultimo_saque: string | null
          updated_at: string
          utm_campaign: string | null
          utm_content: string | null
          utm_id: string | null
          utm_medium: string | null
          utm_source: string | null
          utm_term: string | null
          verificado: boolean
          vip: boolean
        }
        Insert: {
          affiliate_id?: string | null
          cpf?: string | null
          created_at?: string
          data_nascimento?: string | null
          email?: string | null
          expert?: string | null
          ftd_em?: string | null
          id?: string
          last_cashback_amount?: number | null
          last_cashback_paid_at?: string | null
          last_cashback_sms_template_sent?: number
          nome: string
          origem?: string | null
          pais?: string | null
          player_external_id?: string | null
          risco?: string
          saldo_bloqueado?: number
          saldo_bonus?: number
          saldo_carteira?: number
          status?: string
          tags?: string[]
          telefone?: string | null
          tenant_id?: string
          total_apostado?: number
          total_cashback_paid?: number
          total_depositado?: number
          total_sacado?: number
          ultimo_deposito?: string | null
          ultimo_jogo?: string | null
          ultimo_login?: string | null
          ultimo_saque?: string | null
          updated_at?: string
          utm_campaign?: string | null
          utm_content?: string | null
          utm_id?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          utm_term?: string | null
          verificado?: boolean
          vip?: boolean
        }
        Update: {
          affiliate_id?: string | null
          cpf?: string | null
          created_at?: string
          data_nascimento?: string | null
          email?: string | null
          expert?: string | null
          ftd_em?: string | null
          id?: string
          last_cashback_amount?: number | null
          last_cashback_paid_at?: string | null
          last_cashback_sms_template_sent?: number
          nome?: string
          origem?: string | null
          pais?: string | null
          player_external_id?: string | null
          risco?: string
          saldo_bloqueado?: number
          saldo_bonus?: number
          saldo_carteira?: number
          status?: string
          tags?: string[]
          telefone?: string | null
          tenant_id?: string
          total_apostado?: number
          total_cashback_paid?: number
          total_depositado?: number
          total_sacado?: number
          ultimo_deposito?: string | null
          ultimo_jogo?: string | null
          ultimo_login?: string | null
          ultimo_saque?: string | null
          updated_at?: string
          utm_campaign?: string | null
          utm_content?: string | null
          utm_id?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          utm_term?: string | null
          verificado?: boolean
          vip?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "players_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      precall_campaigns: {
        Row: {
          created_at: string
          created_by: string | null
          delay_max_seconds: number
          delay_min_seconds: number
          enviados: number
          falhas: number
          filtro_id: string
          id: string
          ligacoes_feitas: number
          nome: string
          respondidos: number
          session_id: string | null
          status: string
          tenant_id: string
          total_leads: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          delay_max_seconds?: number
          delay_min_seconds?: number
          enviados?: number
          falhas?: number
          filtro_id?: string
          id?: string
          ligacoes_feitas?: number
          nome: string
          respondidos?: number
          session_id?: string | null
          status?: string
          tenant_id?: string
          total_leads?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          delay_max_seconds?: number
          delay_min_seconds?: number
          enviados?: number
          falhas?: number
          filtro_id?: string
          id?: string
          ligacoes_feitas?: number
          nome?: string
          respondidos?: number
          session_id?: string | null
          status?: string
          tenant_id?: string
          total_leads?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "precall_campaigns_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "precall_campaigns_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      precall_leads: {
        Row: {
          called_at: string | null
          campaign_id: string
          created_at: string
          error: string | null
          id: string
          mensagem_enviada: string | null
          observacao: string | null
          player_id: string | null
          responded_at: string | null
          resposta_texto: string | null
          scheduled_at: string
          sent_at: string | null
          status: string
          telefone_e164: string
          template_id_used: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          called_at?: string | null
          campaign_id: string
          created_at?: string
          error?: string | null
          id?: string
          mensagem_enviada?: string | null
          observacao?: string | null
          player_id?: string | null
          responded_at?: string | null
          resposta_texto?: string | null
          scheduled_at?: string
          sent_at?: string | null
          status?: string
          telefone_e164: string
          template_id_used?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Update: {
          called_at?: string | null
          campaign_id?: string
          created_at?: string
          error?: string | null
          id?: string
          mensagem_enviada?: string | null
          observacao?: string | null
          player_id?: string | null
          responded_at?: string | null
          resposta_texto?: string | null
          scheduled_at?: string
          sent_at?: string | null
          status?: string
          telefone_e164?: string
          template_id_used?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "precall_leads_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "precall_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "precall_leads_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "precall_leads_template_id_used_fkey"
            columns: ["template_id_used"]
            isOneToOne: false
            referencedRelation: "precall_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      precall_templates: {
        Row: {
          campaign_id: string
          content: string
          created_at: string
          id: string
          ordem: number
          tenant_id: string
        }
        Insert: {
          campaign_id: string
          content: string
          created_at?: string
          id?: string
          ordem?: number
          tenant_id?: string
        }
        Update: {
          campaign_id?: string
          content?: string
          created_at?: string
          id?: string
          ordem?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "precall_templates_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "precall_campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      rules: {
        Row: {
          active: boolean
          created_at: string
          flow_id: string | null
          id: string
          last_match_count: number
          last_run_at: string | null
          meaning: string
          name: string
          params: Json
          priority: Database["public"]["Enums"]["flow_priority"]
          tenant_id: string
          trigger_type: Database["public"]["Enums"]["flow_trigger_type"]
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          flow_id?: string | null
          id?: string
          last_match_count?: number
          last_run_at?: string | null
          meaning: string
          name: string
          params?: Json
          priority: Database["public"]["Enums"]["flow_priority"]
          tenant_id?: string
          trigger_type: Database["public"]["Enums"]["flow_trigger_type"]
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          flow_id?: string | null
          id?: string
          last_match_count?: number
          last_run_at?: string | null
          meaning?: string
          name?: string
          params?: Json
          priority?: Database["public"]["Enums"]["flow_priority"]
          tenant_id?: string
          trigger_type?: Database["public"]["Enums"]["flow_trigger_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rules_flow_id_fkey"
            columns: ["flow_id"]
            isOneToOne: false
            referencedRelation: "flows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      send_window_settings: {
        Row: {
          created_at: string
          enabled: boolean
          end_minute: number
          id: string
          singleton: boolean
          start_minute: number
          tenant_id: string
          timezone: string
          updated_at: string
          weekdays: number[]
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          end_minute?: number
          id?: string
          singleton?: boolean
          start_minute?: number
          tenant_id?: string
          timezone?: string
          updated_at?: string
          weekdays?: number[]
        }
        Update: {
          created_at?: string
          enabled?: boolean
          end_minute?: number
          id?: string
          singleton?: boolean
          start_minute?: number
          tenant_id?: string
          timezone?: string
          updated_at?: string
          weekdays?: number[]
        }
        Relationships: [
          {
            foreignKeyName: "send_window_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sessions: {
        Row: {
          duracao_segundos: number | null
          encerrado_em: string | null
          id: string
          iniciado_em: string
          player_id: string | null
          provider_event_id: string | null
          tenant_id: string
        }
        Insert: {
          duracao_segundos?: number | null
          encerrado_em?: string | null
          id?: string
          iniciado_em?: string
          player_id?: string | null
          provider_event_id?: string | null
          tenant_id?: string
        }
        Update: {
          duracao_segundos?: number | null
          encerrado_em?: string | null
          id?: string
          iniciado_em?: string
          player_id?: string | null
          provider_event_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sessions_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      shortio_settings: {
        Row: {
          allowed_destination_hosts: string[]
          attribution_mode: string
          default_ttl_days: number | null
          domain: string | null
          domain_id: number | null
          enabled: boolean
          enabled_channels: string[]
          fallback_mode: string
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          allowed_destination_hosts?: string[]
          attribution_mode?: string
          default_ttl_days?: number | null
          domain?: string | null
          domain_id?: number | null
          enabled?: boolean
          enabled_channels?: string[]
          fallback_mode?: string
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          allowed_destination_hosts?: string[]
          attribution_mode?: string
          default_ttl_days?: number | null
          domain?: string | null
          domain_id?: number | null
          enabled?: boolean
          enabled_channels?: string[]
          fallback_mode?: string
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shortio_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_audiences: {
        Row: {
          created_at: string
          criteria: Json
          description: string | null
          id: string
          name: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          criteria?: Json
          description?: string | null
          id?: string
          name: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          criteria?: Json
          description?: string | null
          id?: string
          name?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_audiences_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_campaigns: {
        Row: {
          content: string
          created_at: string
          created_by: string | null
          failed_count: number
          id: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          name: string
          rate_per_minute: number
          recipients: Json
          route: string
          scheduled_at: string
          sent_count: number
          sent_cursor: number
          status: string
          template_id: string | null
          template_snapshot: Json | null
          tenant_id: string
          total_count: number
          track_links: boolean
          updated_at: string
        }
        Insert: {
          content: string
          created_at?: string
          created_by?: string | null
          failed_count?: number
          id?: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          name: string
          rate_per_minute?: number
          recipients?: Json
          route?: string
          scheduled_at: string
          sent_count?: number
          sent_cursor?: number
          status?: string
          template_id?: string | null
          template_snapshot?: Json | null
          tenant_id: string
          total_count?: number
          track_links?: boolean
          updated_at?: string
        }
        Update: {
          content?: string
          created_at?: string
          created_by?: string | null
          failed_count?: number
          id?: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          name?: string
          rate_per_minute?: number
          recipients?: Json
          route?: string
          scheduled_at?: string
          sent_count?: number
          sent_cursor?: number
          status?: string
          template_id?: string | null
          template_snapshot?: Json | null
          tenant_id?: string
          total_count?: number
          track_links?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_campaigns_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "sms_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_campaigns_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_credit_ledger: {
        Row: {
          balance_after: number
          created_at: string
          created_by: string | null
          delta_credits: number
          entry_type: string
          id: string
          idempotency_key: string | null
          metadata: Json
          provider_cost_per_sms: number | null
          reason: string | null
          reference_id: string | null
          reference_type: string | null
          tenant_id: string
          unit_sale_price: number | null
        }
        Insert: {
          balance_after: number
          created_at?: string
          created_by?: string | null
          delta_credits: number
          entry_type: string
          id?: string
          idempotency_key?: string | null
          metadata?: Json
          provider_cost_per_sms?: number | null
          reason?: string | null
          reference_id?: string | null
          reference_type?: string | null
          tenant_id: string
          unit_sale_price?: number | null
        }
        Update: {
          balance_after?: number
          created_at?: string
          created_by?: string | null
          delta_credits?: number
          entry_type?: string
          id?: string
          idempotency_key?: string | null
          metadata?: Json
          provider_cost_per_sms?: number | null
          reason?: string | null
          reference_id?: string | null
          reference_type?: string | null
          tenant_id?: string
          unit_sale_price?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sms_credit_ledger_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_credit_orders: {
        Row: {
          amount_cents: number
          checkout_provider: string
          checkout_url: string | null
          created_at: string
          created_by: string | null
          credits: number
          currency: string
          external_reference: string
          id: string
          metadata: Json
          package_id: string | null
          paid_at: string | null
          status: string
          tenant_id: string
          unit_price: number
          updated_at: string
        }
        Insert: {
          amount_cents: number
          checkout_provider?: string
          checkout_url?: string | null
          created_at?: string
          created_by?: string | null
          credits: number
          currency?: string
          external_reference?: string
          id?: string
          metadata?: Json
          package_id?: string | null
          paid_at?: string | null
          status?: string
          tenant_id: string
          unit_price: number
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          checkout_provider?: string
          checkout_url?: string | null
          created_at?: string
          created_by?: string | null
          credits?: number
          currency?: string
          external_reference?: string
          id?: string
          metadata?: Json
          package_id?: string | null
          paid_at?: string | null
          status?: string
          tenant_id?: string
          unit_price?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_credit_orders_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "sms_credit_packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_credit_orders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_credit_packages: {
        Row: {
          bonus_credits: number
          created_at: string
          credits: number
          currency: string
          id: string
          is_active: boolean
          name: string
          price_cents: number
          sort_order: number
          updated_at: string
        }
        Insert: {
          bonus_credits?: number
          created_at?: string
          credits: number
          currency?: string
          id?: string
          is_active?: boolean
          name: string
          price_cents: number
          sort_order?: number
          updated_at?: string
        }
        Update: {
          bonus_credits?: number
          created_at?: string
          credits?: number
          currency?: string
          id?: string
          is_active?: boolean
          name?: string
          price_cents?: number
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      sms_credit_settings: {
        Row: {
          default_sale_price_per_sms: number
          id: boolean
          low_balance_threshold: number
          min_checkout_credits: number
          provider_cost_per_sms: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          default_sale_price_per_sms?: number
          id?: boolean
          low_balance_threshold?: number
          min_checkout_credits?: number
          provider_cost_per_sms?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          default_sale_price_per_sms?: number
          id?: boolean
          low_balance_threshold?: number
          min_checkout_credits?: number
          provider_cost_per_sms?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      sms_flow_daily_usage: {
        Row: {
          flow_id: string
          reserved_count: number
          tenant_id: string
          updated_at: string
          usage_date: string
        }
        Insert: {
          flow_id: string
          reserved_count?: number
          tenant_id: string
          updated_at?: string
          usage_date: string
        }
        Update: {
          flow_id?: string
          reserved_count?: number
          tenant_id?: string
          updated_at?: string
          usage_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_flow_daily_usage_flow_id_fkey"
            columns: ["flow_id"]
            isOneToOne: false
            referencedRelation: "sms_flows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_flow_daily_usage_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_flow_leads: {
        Row: {
          attempts: number
          created_at: string
          current_step_index: number
          entered_at: string
          exit_reason: string | null
          flow_id: string
          id: string
          last_sent_at: string | null
          locked_at: string | null
          locked_by: string | null
          next_run_at: string
          phone_e164: string
          player_id: string | null
          status: Database["public"]["Enums"]["sms_flow_lead_status"]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          current_step_index?: number
          entered_at?: string
          exit_reason?: string | null
          flow_id: string
          id?: string
          last_sent_at?: string | null
          locked_at?: string | null
          locked_by?: string | null
          next_run_at?: string
          phone_e164: string
          player_id?: string | null
          status?: Database["public"]["Enums"]["sms_flow_lead_status"]
          tenant_id?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          current_step_index?: number
          entered_at?: string
          exit_reason?: string | null
          flow_id?: string
          id?: string
          last_sent_at?: string | null
          locked_at?: string | null
          locked_by?: string | null
          next_run_at?: string
          phone_e164?: string
          player_id?: string | null
          status?: Database["public"]["Enums"]["sms_flow_lead_status"]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_flow_leads_flow_id_fkey"
            columns: ["flow_id"]
            isOneToOne: false
            referencedRelation: "sms_flows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_flow_leads_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_flow_leads_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_flow_steps: {
        Row: {
          content: string | null
          created_at: string
          delay_days: number
          delay_hours: number | null
          flow_id: string
          id: string
          is_active: boolean
          order_index: number
          scheduled_day_offset: number | null
          scheduled_time: string | null
          step_type: string
          template_id: string | null
          template_snapshot: Json | null
          tenant_id: string
          track_links: boolean
        }
        Insert: {
          content?: string | null
          created_at?: string
          delay_days?: number
          delay_hours?: number | null
          flow_id: string
          id?: string
          is_active?: boolean
          order_index?: number
          scheduled_day_offset?: number | null
          scheduled_time?: string | null
          step_type: string
          template_id?: string | null
          template_snapshot?: Json | null
          tenant_id?: string
          track_links?: boolean
        }
        Update: {
          content?: string | null
          created_at?: string
          delay_days?: number
          delay_hours?: number | null
          flow_id?: string
          id?: string
          is_active?: boolean
          order_index?: number
          scheduled_day_offset?: number | null
          scheduled_time?: string | null
          step_type?: string
          template_id?: string | null
          template_snapshot?: Json | null
          tenant_id?: string
          track_links?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "sms_flow_steps_flow_id_fkey"
            columns: ["flow_id"]
            isOneToOne: false
            referencedRelation: "sms_flows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_flow_steps_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "sms_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_flow_steps_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_flows: {
        Row: {
          cooldown_hours: number
          created_at: string
          daily_limit: number
          exit_conditions: Json
          id: string
          is_active: boolean
          name: string
          randomize_templates: boolean
          tenant_id: string
          trigger_name: string | null
          updated_at: string
        }
        Insert: {
          cooldown_hours?: number
          created_at?: string
          daily_limit?: number
          exit_conditions?: Json
          id?: string
          is_active?: boolean
          name: string
          randomize_templates?: boolean
          tenant_id?: string
          trigger_name?: string | null
          updated_at?: string
        }
        Update: {
          cooldown_hours?: number
          created_at?: string
          daily_limit?: number
          exit_conditions?: Json
          id?: string
          is_active?: boolean
          name?: string
          randomize_templates?: boolean
          tenant_id?: string
          trigger_name?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_flows_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_send_logs: {
        Row: {
          content: string
          created_at: string
          delivered_at: string | null
          delivery_status: string | null
          error: string | null
          flow_id: string | null
          flow_lead_id: string | null
          id: string
          idempotency_key: string | null
          last_callback: Json | null
          player_id: string | null
          provider: string
          provider_message_id: string | null
          provider_response: Json
          status: string
          step_index: number | null
          step_label: string | null
          tenant_id: string
          to_phone: string
          trigger_name: string | null
        }
        Insert: {
          content: string
          created_at?: string
          delivered_at?: string | null
          delivery_status?: string | null
          error?: string | null
          flow_id?: string | null
          flow_lead_id?: string | null
          id?: string
          idempotency_key?: string | null
          last_callback?: Json | null
          player_id?: string | null
          provider?: string
          provider_message_id?: string | null
          provider_response?: Json
          status?: string
          step_index?: number | null
          step_label?: string | null
          tenant_id?: string
          to_phone: string
          trigger_name?: string | null
        }
        Update: {
          content?: string
          created_at?: string
          delivered_at?: string | null
          delivery_status?: string | null
          error?: string | null
          flow_id?: string | null
          flow_lead_id?: string | null
          id?: string
          idempotency_key?: string | null
          last_callback?: Json | null
          player_id?: string | null
          provider?: string
          provider_message_id?: string | null
          provider_response?: Json
          status?: string
          step_index?: number | null
          step_label?: string | null
          tenant_id?: string
          to_phone?: string
          trigger_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sms_send_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_suppressions: {
        Row: {
          created_at: string
          id: string
          phone: string
          reason: string
          source: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          phone: string
          reason?: string
          source?: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          id?: string
          phone?: string
          reason?: string
          source?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_suppressions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_template_versions: {
        Row: {
          category: string
          changed_by: string | null
          content: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          tags: string[]
          template_id: string
          tenant_id: string
          version: number
        }
        Insert: {
          category: string
          changed_by?: string | null
          content: string
          created_at?: string
          id?: string
          is_active: boolean
          name: string
          tags?: string[]
          template_id: string
          tenant_id: string
          version: number
        }
        Update: {
          category?: string
          changed_by?: string | null
          content?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          tags?: string[]
          template_id?: string
          tenant_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "sms_template_versions_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "sms_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_template_versions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_templates: {
        Row: {
          category: string
          content: string
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          name: string
          tags: string[]
          tenant_id: string
          updated_at: string
          version: number
        }
        Insert: {
          category?: string
          content: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          name: string
          tags?: string[]
          tenant_id: string
          updated_at?: string
          version?: number
        }
        Update: {
          category?: string
          content?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          name?: string
          tags?: string[]
          tenant_id?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "sms_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      suppressed_emails: {
        Row: {
          created_at: string
          email: string
          id: string
          notes: string | null
          reason: string
          source: string | null
          tenant_id: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          notes?: string | null
          reason: string
          source?: string | null
          tenant_id?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          notes?: string | null
          reason?: string
          source?: string | null
          tenant_id?: string | null
        }
        Relationships: []
      }
      system_alerts: {
        Row: {
          alert_type: string
          created_at: string
          details: Json
          fired_at: string
          id: string
          message: string | null
          severity: string
          tenant_id: string
          title: string
        }
        Insert: {
          alert_type: string
          created_at?: string
          details?: Json
          fired_at?: string
          id?: string
          message?: string | null
          severity: string
          tenant_id?: string
          title: string
        }
        Update: {
          alert_type?: string
          created_at?: string
          details?: Json
          fired_at?: string
          id?: string
          message?: string | null
          severity?: string
          tenant_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "system_alerts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_audit_logs: {
        Row: {
          action: string
          actor_user_id: string | null
          after_data: Json | null
          before_data: Json | null
          created_at: string
          entity_id: string | null
          entity_type: string
          id: string
          metadata: Json
          tenant_id: string
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          after_data?: Json | null
          before_data?: Json | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: string
          metadata?: Json
          tenant_id: string
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          after_data?: Json | null
          before_data?: Json | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
          metadata?: Json
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_audit_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_daily_metrics: {
        Row: {
          approved_deposit_amount: number
          approved_deposit_count: number
          approved_depositor_count: number
          approved_withdrawal_amount: number
          approved_withdrawal_count: number
          ftds: number
          generated_pix_count: number
          metric_date: string
          registrations: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          approved_deposit_amount?: number
          approved_deposit_count?: number
          approved_depositor_count?: number
          approved_withdrawal_amount?: number
          approved_withdrawal_count?: number
          ftds?: number
          generated_pix_count?: number
          metric_date: string
          registrations?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          approved_deposit_amount?: number
          approved_deposit_count?: number
          approved_depositor_count?: number
          approved_withdrawal_amount?: number
          approved_withdrawal_count?: number
          ftds?: number
          generated_pix_count?: number
          metric_date?: string
          registrations?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_daily_metrics_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_sms_credit_balances: {
        Row: {
          balance_credits: number
          lifetime_manual_credits: number
          lifetime_purchased_credits: number
          lifetime_used_credits: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          balance_credits?: number
          lifetime_manual_credits?: number
          lifetime_purchased_credits?: number
          lifetime_used_credits?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          balance_credits?: number
          lifetime_manual_credits?: number
          lifetime_purchased_credits?: number
          lifetime_used_credits?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_sms_credit_balances_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_sms_pricing: {
        Row: {
          provider_cost_per_sms: number | null
          sale_price_per_sms: number | null
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          provider_cost_per_sms?: number | null
          sale_price_per_sms?: number | null
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          provider_cost_per_sms?: number | null
          sale_price_per_sms?: number | null
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_sms_pricing_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          created_at: string
          crm_model: string
          id: string
          legacy_webhook: boolean
          limits: Json
          metadata: Json
          nome: string
          plano: string
          slug: string
          status: string
          updated_at: string
          webhook_token: string
        }
        Insert: {
          created_at?: string
          crm_model?: string
          id?: string
          legacy_webhook?: boolean
          limits?: Json
          metadata?: Json
          nome: string
          plano?: string
          slug: string
          status?: string
          updated_at?: string
          webhook_token?: string
        }
        Update: {
          created_at?: string
          crm_model?: string
          id?: string
          legacy_webhook?: boolean
          limits?: Json
          metadata?: Json
          nome?: string
          plano?: string
          slug?: string
          status?: string
          updated_at?: string
          webhook_token?: string
        }
        Relationships: []
      }
      tracked_links: {
        Row: {
          canonical_url_hash: string
          created_at: string
          expires_at: string | null
          id: string
          last_synced_at: string | null
          original_url: string
          path: string | null
          short_url: string
          shortio_link_id: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          canonical_url_hash: string
          created_at?: string
          expires_at?: string | null
          id?: string
          last_synced_at?: string | null
          original_url: string
          path?: string | null
          short_url: string
          shortio_link_id: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          canonical_url_hash?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          last_synced_at?: string | null
          original_url?: string
          path?: string | null
          short_url?: string
          shortio_link_id?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tracked_links_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          tenant_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          tenant_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          tenant_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      voice_contact_policies: {
        Row: {
          cooldown_hours: number
          created_at: string
          enabled: boolean
          rolling_24h_limit: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          cooldown_hours?: number
          created_at?: string
          enabled?: boolean
          rolling_24h_limit?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          cooldown_hours?: number
          created_at?: string
          enabled?: boolean
          rolling_24h_limit?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "voice_contact_policies_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_configs: {
        Row: {
          ativo: boolean
          created_at: string
          id: string
          nome: string
          secret: string | null
          tenant_id: string
          ultima_conexao: string | null
          url: string
        }
        Insert: {
          ativo?: boolean
          created_at?: string
          id?: string
          nome: string
          secret?: string | null
          tenant_id?: string
          ultima_conexao?: string | null
          url: string
        }
        Update: {
          ativo?: boolean
          created_at?: string
          id?: string
          nome?: string
          secret?: string | null
          tenant_id?: string
          ultima_conexao?: string | null
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_configs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_event_receipts: {
        Row: {
          attempt_count: number
          completed_at: string | null
          created_at: string
          event_name: string
          last_error: string | null
          locked_at: string
          provider_event_id: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          attempt_count?: number
          completed_at?: string | null
          created_at?: string
          event_name: string
          last_error?: string | null
          locked_at?: string
          provider_event_id: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          attempt_count?: number
          completed_at?: string | null
          created_at?: string
          event_name?: string
          last_error?: string | null
          locked_at?: string
          provider_event_id?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_event_receipts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_logs: {
        Row: {
          created_at: string
          evento: string
          id: string
          payload: Json
          status: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          evento: string
          id?: string
          payload?: Json
          status?: string
          tenant_id?: string
        }
        Update: {
          created_at?: string
          evento?: string
          id?: string
          payload?: Json
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_chats: {
        Row: {
          created_at: string
          id: string
          is_group: boolean
          last_message: string | null
          last_message_at: string | null
          name: string | null
          phone: string | null
          profile_pic_url: string | null
          remote_jid: string
          session_id: string
          tenant_id: string
          unread_count: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_group?: boolean
          last_message?: string | null
          last_message_at?: string | null
          name?: string | null
          phone?: string | null
          profile_pic_url?: string | null
          remote_jid: string
          session_id: string
          tenant_id?: string
          unread_count?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_group?: boolean
          last_message?: string | null
          last_message_at?: string | null
          name?: string | null
          phone?: string | null
          profile_pic_url?: string | null
          remote_jid?: string
          session_id?: string
          tenant_id?: string
          unread_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_chats_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_chats_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_external_events: {
        Row: {
          attempts: number
          created_at: string
          error: string | null
          http_status: number | null
          id: string
          is_test: boolean
          payload: Json
          phone_e164: string | null
          player_id: string | null
          response_body: string | null
          status: string
          tenant_id: string
          trigger_type: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          error?: string | null
          http_status?: number | null
          id?: string
          is_test?: boolean
          payload?: Json
          phone_e164?: string | null
          player_id?: string | null
          response_body?: string | null
          status?: string
          tenant_id: string
          trigger_type: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          error?: string | null
          http_status?: number | null
          id?: string
          is_test?: boolean
          payload?: Json
          phone_e164?: string | null
          player_id?: string | null
          response_body?: string | null
          status?: string
          tenant_id?: string
          trigger_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_external_events_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_external_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_external_integrations: {
        Row: {
          active: boolean
          created_at: string
          disable_internal: boolean
          id: string
          last_error: string | null
          last_success_at: string | null
          tenant_id: string
          triggers: string[]
          updated_at: string
          url: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          disable_internal?: boolean
          id?: string
          last_error?: string | null
          last_success_at?: string | null
          tenant_id: string
          triggers?: string[]
          updated_at?: string
          url: string
        }
        Update: {
          active?: boolean
          created_at?: string
          disable_internal?: boolean
          id?: string
          last_error?: string | null
          last_success_at?: string | null
          tenant_id?: string
          triggers?: string[]
          updated_at?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_external_integrations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_messages: {
        Row: {
          chat_id: string
          created_at: string
          evolution_message_id: string | null
          from_me: boolean
          id: string
          media_duration: number | null
          media_filename: string | null
          media_mimetype: string | null
          media_size: number | null
          media_url: string | null
          message_timestamp: string
          message_type: string
          raw: Json
          remote_jid: string
          sender_jid: string | null
          sender_name: string | null
          session_id: string
          status: string | null
          tenant_id: string
          text: string | null
        }
        Insert: {
          chat_id: string
          created_at?: string
          evolution_message_id?: string | null
          from_me?: boolean
          id?: string
          media_duration?: number | null
          media_filename?: string | null
          media_mimetype?: string | null
          media_size?: number | null
          media_url?: string | null
          message_timestamp?: string
          message_type?: string
          raw?: Json
          remote_jid: string
          sender_jid?: string | null
          sender_name?: string | null
          session_id: string
          status?: string | null
          tenant_id?: string
          text?: string | null
        }
        Update: {
          chat_id?: string
          created_at?: string
          evolution_message_id?: string | null
          from_me?: boolean
          id?: string
          media_duration?: number | null
          media_filename?: string | null
          media_mimetype?: string | null
          media_size?: number | null
          media_url?: string | null
          message_timestamp?: string
          message_type?: string
          raw?: Json
          remote_jid?: string
          sender_jid?: string | null
          sender_name?: string | null
          session_id?: string
          status?: string | null
          tenant_id?: string
          text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_messages_chat_id_fkey"
            columns: ["chat_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_chats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_messages_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_messages_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_proxies: {
        Row: {
          created_at: string
          host: string
          id: string
          last_test_error: string | null
          last_test_ok: boolean | null
          last_tested_at: string | null
          name: string
          notes: string | null
          password_encrypted: string | null
          port: number
          protocol: string
          provider: string | null
          status: string
          tenant_id: string
          updated_at: string
          username: string | null
        }
        Insert: {
          created_at?: string
          host: string
          id?: string
          last_test_error?: string | null
          last_test_ok?: boolean | null
          last_tested_at?: string | null
          name: string
          notes?: string | null
          password_encrypted?: string | null
          port: number
          protocol: string
          provider?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
          username?: string | null
        }
        Update: {
          created_at?: string
          host?: string
          id?: string
          last_test_error?: string | null
          last_test_ok?: boolean | null
          last_tested_at?: string | null
          name?: string
          notes?: string | null
          password_encrypted?: string | null
          port?: number
          protocol?: string
          provider?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_proxies_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_proxy_logs: {
        Row: {
          created_at: string
          detail: Json
          event: string
          id: string
          proxy_id: string | null
          session_id: string | null
          tenant_id: string
        }
        Insert: {
          created_at?: string
          detail?: Json
          event: string
          id?: string
          proxy_id?: string | null
          session_id?: string | null
          tenant_id?: string
        }
        Update: {
          created_at?: string
          detail?: Json
          event?: string
          id?: string
          proxy_id?: string | null
          session_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_proxy_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_sessions: {
        Row: {
          api_status: string | null
          created_at: string
          daily_limit: number
          health_score: number
          hourly_limit: number
          id: string
          instance_name: string
          is_active: boolean
          last_connected_at: string | null
          last_disconnected_at: string | null
          messages_sent_today: number
          name: string
          phone_number: string | null
          proxy_id: string | null
          qr_code: string | null
          queue_pending: number
          status: string
          tenant_id: string
          updated_at: string
          warmup_score: number
        }
        Insert: {
          api_status?: string | null
          created_at?: string
          daily_limit?: number
          health_score?: number
          hourly_limit?: number
          id?: string
          instance_name: string
          is_active?: boolean
          last_connected_at?: string | null
          last_disconnected_at?: string | null
          messages_sent_today?: number
          name: string
          phone_number?: string | null
          proxy_id?: string | null
          qr_code?: string | null
          queue_pending?: number
          status?: string
          tenant_id?: string
          updated_at?: string
          warmup_score?: number
        }
        Update: {
          api_status?: string | null
          created_at?: string
          daily_limit?: number
          health_score?: number
          hourly_limit?: number
          id?: string
          instance_name?: string
          is_active?: boolean
          last_connected_at?: string | null
          last_disconnected_at?: string | null
          messages_sent_today?: number
          name?: string
          phone_number?: string | null
          proxy_id?: string | null
          qr_code?: string | null
          queue_pending?: number
          status?: string
          tenant_id?: string
          updated_at?: string
          warmup_score?: number
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_sessions_proxy_id_fkey"
            columns: ["proxy_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_proxies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_sessions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      withdrawals: {
        Row: {
          completed_at: string | null
          created_at: string
          event_id: string | null
          external_id: string | null
          id: string
          metodo: string | null
          player_id: string | null
          provider_status: string | null
          raw_payload: Json
          status: string
          tenant_id: string
          updated_at: string
          valor: number
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          event_id?: string | null
          external_id?: string | null
          id?: string
          metodo?: string | null
          player_id?: string | null
          provider_status?: string | null
          raw_payload?: Json
          status?: string
          tenant_id?: string
          updated_at?: string
          valor: number
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          event_id?: string | null
          external_id?: string | null
          id?: string
          metodo?: string | null
          player_id?: string | null
          provider_status?: string | null
          raw_payload?: Json
          status?: string
          tenant_id?: string
          updated_at?: string
          valor?: number
        }
        Relationships: [
          {
            foreignKeyName: "withdrawals_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "withdrawals_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      admin_adjust_sms_credits: {
        Args: {
          _delta: number
          _idempotency_key?: string
          _reason: string
          _tenant: string
        }
        Returns: Json
      }
      admin_clear_tenant_sms_pricing: {
        Args: { _tenant: string }
        Returns: Json
      }
      admin_list_users_with_usage: {
        Args: { _from?: string; _to?: string }
        Returns: {
          banned_until: string
          call_cost: number
          call_minutes: number
          created_at: string
          email: string
          email_cost: number
          email_count: number
          last_sign_in_at: string
          role: string
          sms_cost: number
          sms_count: number
          tenant_id: string
          tenant_nome: string
          total_cost: number
          user_id: string
        }[]
      }
      admin_mark_sms_credit_order_paid: {
        Args: {
          _checkout_provider?: string
          _external_reference?: string
          _metadata?: Json
          _order_id: string
        }
        Returns: Json
      }
      admin_platform_metrics: {
        Args: { _from?: string; _to?: string }
        Returns: Json
      }
      admin_set_sms_credit_settings: {
        Args: {
          _default_sale_price_per_sms: number
          _low_balance_threshold: number
          _min_checkout_credits: number
          _provider_cost_per_sms: number
        }
        Returns: Json
      }
      admin_set_tenant_sms_pricing: {
        Args: {
          _provider_cost_per_sms?: number
          _sale_price_per_sms?: number
          _tenant: string
        }
        Returns: Json
      }
      admin_sms_credit_overview: {
        Args: never
        Returns: {
          balance_credits: number
          has_custom_pricing: boolean
          last_ledger_at: string
          lifetime_manual_credits: number
          lifetime_purchased_credits: number
          lifetime_used_credits: number
          provider_cost_per_sms: number
          sale_price_per_sms: number
          tenant_id: string
          tenant_name: string
        }[]
      }
      apply_sms_credit_mutation: {
        Args: {
          _created_by?: string
          _delta: number
          _entry_type: string
          _idempotency_key?: string
          _metadata?: Json
          _reason?: string
          _reference_id?: string
          _reference_type?: string
          _tenant: string
        }
        Returns: Json
      }
      claim_call_flow_progress: {
        Args: { p_limit: number }
        Returns: {
          attempts_on_block: number
          current_block_index: number
          exit_reason: string | null
          flow_id: string
          id: string
          last_call_at: string | null
          last_call_duration: number | null
          last_call_result: string | null
          lead_id: string | null
          next_run_at: string
          phone_e164: string | null
          player_id: string | null
          started_at: string
          status: Database["public"]["Enums"]["call_flow_progress_status"]
          tenant_id: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "call_flow_progress"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_due_email_campaigns: {
        Args: { p_limit: number }
        Returns: {
          audience_filter: Json
          created_at: string
          id: string
          locked_at: string | null
          locked_by: string | null
          name: string
          scheduled_at: string | null
          smtp_id: string | null
          stats: Json
          status: string
          template_id: string | null
          template_snapshot: Json | null
          tenant_id: string
          track_links: boolean
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "email_campaigns"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_due_journey_enrollments: {
        Args: { p_limit?: number }
        Returns: {
          id: string
        }[]
      }
      claim_due_sms_campaigns: {
        Args: { p_limit: number }
        Returns: {
          content: string
          created_at: string
          created_by: string | null
          failed_count: number
          id: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          name: string
          rate_per_minute: number
          recipients: Json
          route: string
          scheduled_at: string
          sent_count: number
          sent_cursor: number
          status: string
          template_id: string | null
          template_snapshot: Json | null
          tenant_id: string
          total_count: number
          track_links: boolean
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "sms_campaigns"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_email_flow_leads: {
        Args: { p_limit: number }
        Returns: {
          attempts: number
          created_at: string
          current_block_index: number
          email: string
          entered_at: string
          exit_reason: string | null
          flow_id: string
          id: string
          last_sent_at: string | null
          last_template_id: string | null
          locked_at: string | null
          locked_by: string | null
          next_run_at: string
          player_id: string | null
          status: Database["public"]["Enums"]["email_flow_lead_status"]
          tenant_id: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "email_flow_leads"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_meta_sync_jobs: {
        Args: { p_limit?: number; p_worker_id?: string }
        Returns: {
          account_id: string
          attempt_count: number
          created_at: string
          days: number
          finished_at: string | null
          id: string
          last_error: string | null
          locked_at: string | null
          max_attempts: number
          next_attempt_at: string
          rows_imported: number
          run_id: string
          started_at: string | null
          status: string
          tenant_id: string
          updated_at: string
          worker_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "meta_sync_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_sms_flow_leads: {
        Args: { p_limit: number }
        Returns: {
          attempts: number
          created_at: string
          current_step_index: number
          entered_at: string
          exit_reason: string | null
          flow_id: string
          id: string
          last_sent_at: string | null
          locked_at: string | null
          locked_by: string | null
          next_run_at: string
          phone_e164: string
          player_id: string | null
          status: Database["public"]["Enums"]["sms_flow_lead_status"]
          tenant_id: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "sms_flow_leads"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_webhook_event: {
        Args: {
          p_event_name: string
          p_provider_event_id: string
          p_tenant_id: string
        }
        Returns: boolean
      }
      consume_dispatch_budget: {
        Args: { p_channel: string; p_want: number }
        Returns: number
      }
      create_sms_credit_checkout: {
        Args: { _credits?: number; _package_id?: string; _tenant?: string }
        Returns: Json
      }
      current_tenant_id: { Args: never; Returns: string }
      dashboard_summary_v2: {
        Args: {
          _from: string
          _prev_from: string
          _prev_to: string
          _reset_at?: string
          _tenant: string
          _to: string
        }
        Returns: Json
      }
      dashboard_totals: {
        Args: { _from: string; _reset_at: string; _tenant: string; _to: string }
        Returns: Json
      }
      gamification_snapshot_v2: { Args: { _tenant?: string }; Returns: Json }
      get_my_webhook_token: { Args: { _tenant: string }; Returns: string }
      get_players_alert_ids: {
        Args: never
        Returns: {
          player_id: string
          tipo: string
        }[]
      }
      get_tenant_webhook_token: { Args: { _tenant: string }; Returns: string }
      get_webhook_config_secret: { Args: { _id: string }; Returns: string }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      has_tenant_access: {
        Args: { _tenant_id: string; _user_id?: string }
        Returns: boolean
      }
      increment_player_totals: {
        Args: {
          p_delta_deposito: number
          p_delta_saque: number
          p_player_id: string
          p_set_ftd: boolean
          p_set_ultimo_deposito: boolean
          p_set_ultimo_saque: boolean
        }
        Returns: undefined
      }
      is_super_admin: { Args: { _user_id?: string }; Returns: boolean }
      is_tenant_admin: { Args: { _tenant: string }; Returns: boolean }
      is_tenant_owner: { Args: { _tenant: string }; Returns: boolean }
      journey_metrics: {
        Args: { p_journey_id: string; p_tenant_id: string }
        Returns: Json
      }
      normalize_brazilian_phone: { Args: { p_raw: string }; Returns: string }
      player_filter_contextual_facets_v1: {
        Args: {
          _date_field?: string
          _date_from?: string
          _date_to?: string
          _filters?: string[]
          _gamification_level?: string
          _gamification_status?: string
          _operator?: string
          _search?: string
          _tenant?: string
        }
        Returns: Json
      }
      player_filter_facets_v1:
        | { Args: { _tenant?: string }; Returns: Json }
        | {
            Args: {
              _gamification_level?: string
              _gamification_status?: string
              _tenant?: string
            }
            Returns: Json
          }
      player_matches_behavior_filters: {
        Args: {
          _filters?: string[]
          _operator?: string
          _vip_threshold?: number
          p: Database["public"]["Tables"]["players"]["Row"]
        }
        Returns: boolean
      }
      players_by_behavior_filters: {
        Args: {
          _filters?: string[]
          _operator?: string
          _vip_threshold?: number
        }
        Returns: {
          affiliate_id: string | null
          cpf: string | null
          created_at: string
          data_nascimento: string | null
          email: string | null
          expert: string | null
          ftd_em: string | null
          id: string
          last_cashback_amount: number | null
          last_cashback_paid_at: string | null
          last_cashback_sms_template_sent: number
          nome: string
          origem: string | null
          pais: string | null
          player_external_id: string | null
          risco: string
          saldo_bloqueado: number
          saldo_bonus: number
          saldo_carteira: number
          status: string
          tags: string[]
          telefone: string | null
          tenant_id: string
          total_apostado: number
          total_cashback_paid: number
          total_depositado: number
          total_sacado: number
          ultimo_deposito: string | null
          ultimo_jogo: string | null
          ultimo_login: string | null
          ultimo_saque: string | null
          updated_at: string
          utm_campaign: string | null
          utm_content: string | null
          utm_id: string | null
          utm_medium: string | null
          utm_source: string | null
          utm_term: string | null
          verificado: boolean
          vip: boolean
        }[]
        SetofOptions: {
          from: "*"
          to: "players"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      reconcile_meta_attributions: {
        Args: { p_tenant_id: string }
        Returns: number
      }
      record_financial_webhook_batch: {
        Args: { p_items: Json }
        Returns: number
      }
      record_financial_webhook_event: {
        Args: {
          p_amount: number
          p_event_at: string
          p_event_id: string
          p_external_id: string
          p_kind: string
          p_method: string
          p_payload: Json
          p_player_id: string
          p_provider_status: string
          p_status: string
          p_tenant_id: string
        }
        Returns: {
          became_approved: boolean
          current_status: string
          previous_status: string
          row_id: string
        }[]
      }
      recover_orphaned_journey_claims: { Args: never; Returns: number }
      recover_stuck_email_campaigns: { Args: never; Returns: number }
      recover_stuck_email_leads: { Args: never; Returns: number }
      recover_stuck_sms_campaigns: { Args: never; Returns: number }
      recover_stuck_sms_leads: { Args: never; Returns: number }
      refresh_dashboard_daily_metric: {
        Args: { _date?: string; _tenant: string }
        Returns: undefined
      }
      refresh_dashboard_daily_metrics_range: {
        Args: { _from: string; _tenant: string; _to: string }
        Returns: undefined
      }
      refresh_tenant_daily_metric_day: {
        Args: { _date: string; _tenant: string }
        Returns: undefined
      }
      refund_sms_credits: {
        Args: {
          _credits: number
          _idempotency_key: string
          _reason?: string
          _reference_id: string
          _reference_type: string
          _tenant: string
        }
        Returns: Json
      }
      register_provider_throttle: {
        Args: {
          p_channel: string
          p_error: string
          p_retry_after_seconds: number
        }
        Returns: undefined
      }
      reserve_journey_delivery: {
        Args: {
          p_channel: string
          p_cooldown_hours: number
          p_daily_limit: number
          p_enrollment_id: string
          p_journey_id: string
          p_player_id: string
          p_step_id: string
          p_step_position: number
          p_tenant_id: string
        }
        Returns: {
          blocked_reason: string
          execution_id: string
          idempotency_key: string
          retry_at: string
        }[]
      }
      reserve_sms_credits: {
        Args: {
          _credits: number
          _idempotency_key: string
          _reference_id: string
          _reference_type: string
          _tenant: string
        }
        Returns: Json
      }
      reserve_sms_flow_daily_slot: {
        Args: {
          _daily_limit: number
          _flow: string
          _tenant: string
          _usage_date?: string
        }
        Returns: boolean
      }
      resolve_campaign_channel_eligibility: {
        Args: { p_candidates: Json; p_channel: string; p_tenant_id: string }
        Returns: Json
      }
      resolve_sms_audience_v2: {
        Args: { _criteria: Json; _tenant: string }
        Returns: Json
      }
      save_journey_draft: {
        Args: {
          p_actor_user_id: string
          p_journey: Json
          p_journey_id: string
          p_steps: Json
          p_tenant_id: string
        }
        Returns: string
      }
      sms_audience_player_matches: {
        Args: {
          _cashback_at: string
          _cooling: number
          _created_at: string
          _criteria: Json
          _ftd_at: string
          _has_pending_pix: boolean
          _has_pending_withdrawal: boolean
          _has_withdrawal: boolean
          _last_deposit_at: string
          _last_login_at: string
          _sleeping: number
          _thresholds: Json
          _total_deposited: number
        }
        Returns: boolean
      }
      sms_credit_summary: { Args: { _tenant?: string }; Returns: Json }
      sms_effective_pricing: { Args: { _tenant?: string }; Returns: Json }
    }
    Enums: {
      app_role: "admin" | "user" | "super_admin" | "owner" | "member" | "gestor"
      call_audio_status: "pending" | "generating" | "ready" | "failed"
      call_flow_block_type: "call" | "delay"
      call_flow_progress_status:
        | "active"
        | "completed"
        | "exited"
        | "paused"
        | "waiting"
        | "cancelled"
      call_flow_sms_condition:
        | "always"
        | "answered"
        | "not_answered"
        | "listened_gte"
        | "listened_lt"
        | "hangup_before"
        | "voicemail"
        | "busy"
        | "failed"
        | "no_answer"
      call_flow_sms_mode:
        | "none"
        | "always"
        | "answered"
        | "not_answered"
        | "listened_seconds"
      call_history_status:
        | "pending"
        | "calling"
        | "answered"
        | "not_answered"
        | "busy"
        | "failed"
        | "completed"
        | "converted"
        | "cancelled"
      call_provider_auth:
        | "none"
        | "bearer_token"
        | "api_key_header"
        | "basic_auth"
        | "custom_headers"
      call_provider_mode: "api" | "webhook"
      call_provider_type:
        | "zenvia"
        | "totalvoice"
        | "twilio"
        | "vonage"
        | "plivo"
        | "custom_api"
        | "custom_webhook"
      call_queue_status:
        | "pending_audio"
        | "audio_ready"
        | "queued"
        | "waiting_provider"
        | "calling"
        | "completed"
        | "failed"
        | "cancelled"
        | "paused"
      call_script_status: "active" | "inactive" | "draft"
      email_flow_block_type:
        | "start"
        | "send_email"
        | "delay"
        | "condition"
        | "tag"
        | "remove"
        | "end"
      email_flow_lead_status:
        | "pending"
        | "running"
        | "completed"
        | "exited"
        | "failed"
      email_trigger_type:
        | "recuperacao_vip"
        | "vip_esfriando"
        | "receita_em_queda"
        | "lead_quente_esfriando"
        | "quase_vip"
        | "alto_potencial"
        | "reativacao_em_curso"
        | "dinheiro_parado"
        | "engajado_sem_converter"
        | "frequencia_caindo"
        | "cadastrados_sem_deposito"
        | "sem_login_7_14"
        | "sem_login_15_24"
        | "sem_login_25_34"
        | "sem_login_35_44"
        | "sem_login_45_59"
        | "sem_login_60_mais"
        | "cashback_pago"
        | "lead_cadastrado"
      flow_block_type:
        | "text"
        | "image"
        | "video"
        | "audio"
        | "document"
        | "delay"
      flow_lead_status:
        | "pending"
        | "running"
        | "completed"
        | "exited"
        | "failed"
        | "cooldown"
      flow_priority: "critico" | "alto" | "medio" | "baixo"
      flow_trigger_type:
        | "recuperacao_vip"
        | "vip_esfriando"
        | "receita_em_queda"
        | "lead_quente_esfriando"
        | "quase_vip"
        | "alto_potencial"
        | "reativacao_em_curso"
        | "jogador_em_momento"
        | "janela_ideal"
        | "dinheiro_parado"
        | "engajado_sem_converter"
        | "frequencia_caindo"
        | "cadastrados_sem_deposito"
        | "sem_login_7_14"
        | "sem_login_15_24"
        | "sem_login_25_34"
        | "sem_login_35_44"
        | "sem_login_45_59"
        | "sem_login_60_mais"
      followup_acao:
        | "whatsapp"
        | "sms"
        | "bonus"
        | "gerente"
        | "campanha"
        | "acompanhamento"
        | "copiar"
        | "convertido"
        | "sem_resposta"
      journey_enrollment_status:
        | "active"
        | "waiting"
        | "paused"
        | "completed"
        | "exited"
        | "failed"
      journey_execution_status:
        | "pending"
        | "claimed"
        | "sent"
        | "delivered"
        | "skipped"
        | "retrying"
        | "failed"
        | "cancelled"
      journey_status: "draft" | "active" | "paused" | "archived"
      journey_step_type:
        | "wait"
        | "sms"
        | "email"
        | "voice"
        | "condition"
        | "split"
        | "update_player"
        | "end"
      sms_flow_lead_status:
        | "pending"
        | "running"
        | "completed"
        | "exited"
        | "failed"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      app_role: ["admin", "user", "super_admin", "owner", "member", "gestor"],
      call_audio_status: ["pending", "generating", "ready", "failed"],
      call_flow_block_type: ["call", "delay"],
      call_flow_progress_status: [
        "active",
        "completed",
        "exited",
        "paused",
        "waiting",
        "cancelled",
      ],
      call_flow_sms_condition: [
        "always",
        "answered",
        "not_answered",
        "listened_gte",
        "listened_lt",
        "hangup_before",
        "voicemail",
        "busy",
        "failed",
        "no_answer",
      ],
      call_flow_sms_mode: [
        "none",
        "always",
        "answered",
        "not_answered",
        "listened_seconds",
      ],
      call_history_status: [
        "pending",
        "calling",
        "answered",
        "not_answered",
        "busy",
        "failed",
        "completed",
        "converted",
        "cancelled",
      ],
      call_provider_auth: [
        "none",
        "bearer_token",
        "api_key_header",
        "basic_auth",
        "custom_headers",
      ],
      call_provider_mode: ["api", "webhook"],
      call_provider_type: [
        "zenvia",
        "totalvoice",
        "twilio",
        "vonage",
        "plivo",
        "custom_api",
        "custom_webhook",
      ],
      call_queue_status: [
        "pending_audio",
        "audio_ready",
        "queued",
        "waiting_provider",
        "calling",
        "completed",
        "failed",
        "cancelled",
        "paused",
      ],
      call_script_status: ["active", "inactive", "draft"],
      email_flow_block_type: [
        "start",
        "send_email",
        "delay",
        "condition",
        "tag",
        "remove",
        "end",
      ],
      email_flow_lead_status: [
        "pending",
        "running",
        "completed",
        "exited",
        "failed",
      ],
      email_trigger_type: [
        "recuperacao_vip",
        "vip_esfriando",
        "receita_em_queda",
        "lead_quente_esfriando",
        "quase_vip",
        "alto_potencial",
        "reativacao_em_curso",
        "dinheiro_parado",
        "engajado_sem_converter",
        "frequencia_caindo",
        "cadastrados_sem_deposito",
        "sem_login_7_14",
        "sem_login_15_24",
        "sem_login_25_34",
        "sem_login_35_44",
        "sem_login_45_59",
        "sem_login_60_mais",
        "cashback_pago",
        "lead_cadastrado",
      ],
      flow_block_type: ["text", "image", "video", "audio", "document", "delay"],
      flow_lead_status: [
        "pending",
        "running",
        "completed",
        "exited",
        "failed",
        "cooldown",
      ],
      flow_priority: ["critico", "alto", "medio", "baixo"],
      flow_trigger_type: [
        "recuperacao_vip",
        "vip_esfriando",
        "receita_em_queda",
        "lead_quente_esfriando",
        "quase_vip",
        "alto_potencial",
        "reativacao_em_curso",
        "jogador_em_momento",
        "janela_ideal",
        "dinheiro_parado",
        "engajado_sem_converter",
        "frequencia_caindo",
        "cadastrados_sem_deposito",
        "sem_login_7_14",
        "sem_login_15_24",
        "sem_login_25_34",
        "sem_login_35_44",
        "sem_login_45_59",
        "sem_login_60_mais",
      ],
      followup_acao: [
        "whatsapp",
        "sms",
        "bonus",
        "gerente",
        "campanha",
        "acompanhamento",
        "copiar",
        "convertido",
        "sem_resposta",
      ],
      journey_enrollment_status: [
        "active",
        "waiting",
        "paused",
        "completed",
        "exited",
        "failed",
      ],
      journey_execution_status: [
        "pending",
        "claimed",
        "sent",
        "delivered",
        "skipped",
        "retrying",
        "failed",
        "cancelled",
      ],
      journey_status: ["draft", "active", "paused", "archived"],
      journey_step_type: [
        "wait",
        "sms",
        "email",
        "voice",
        "condition",
        "split",
        "update_player",
        "end",
      ],
      sms_flow_lead_status: [
        "pending",
        "running",
        "completed",
        "exited",
        "failed",
      ],
    },
  },
} as const
