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
          created_at: string
          external_id: string | null
          id: string
          metodo: string | null
          player_id: string | null
          status: string
          tenant_id: string
          valor: number
        }
        Insert: {
          created_at?: string
          external_id?: string | null
          id?: string
          metodo?: string | null
          player_id?: string | null
          status?: string
          tenant_id?: string
          valor: number
        }
        Update: {
          created_at?: string
          external_id?: string | null
          id?: string
          metodo?: string | null
          player_id?: string | null
          status?: string
          tenant_id?: string
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
          tenant_id: string
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
          tenant_id?: string
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
          tenant_id?: string
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
      email_templates: {
        Row: {
          body_html: string
          body_text: string
          created_at: string
          from_name: string | null
          id: string
          is_active: boolean
          name: string
          preheader: string | null
          subject: string
          tags: string[]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          body_html?: string
          body_text?: string
          created_at?: string
          from_name?: string | null
          id?: string
          is_active?: boolean
          name: string
          preheader?: string | null
          subject: string
          tags?: string[]
          tenant_id?: string
          updated_at?: string
        }
        Update: {
          body_html?: string
          body_text?: string
          created_at?: string
          from_name?: string | null
          id?: string
          is_active?: boolean
          name?: string
          preheader?: string | null
          subject?: string
          tags?: string[]
          tenant_id?: string
          updated_at?: string
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
          tenant_id: string
          tipo: string
          valor: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          metadata?: Json
          player_id?: string | null
          tenant_id?: string
          tipo: string
          valor?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          metadata?: Json
          player_id?: string | null
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
          utm_medium: string | null
          utm_source: string | null
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
          utm_medium?: string | null
          utm_source?: string | null
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
          utm_medium?: string | null
          utm_source?: string | null
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
          tenant_id: string
        }
        Insert: {
          duracao_segundos?: number | null
          encerrado_em?: string | null
          id?: string
          iniciado_em?: string
          player_id?: string | null
          tenant_id?: string
        }
        Update: {
          duracao_segundos?: number | null
          encerrado_em?: string | null
          id?: string
          iniciado_em?: string
          player_id?: string | null
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
          tenant_id: string
          total_count: number
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
          tenant_id: string
          total_count?: number
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
          tenant_id?: string
          total_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_campaigns_tenant_id_fkey"
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
          flow_id: string
          id: string
          is_active: boolean
          order_index: number
          scheduled_day_offset: number | null
          scheduled_time: string | null
          step_type: string
          tenant_id: string
        }
        Insert: {
          content?: string | null
          created_at?: string
          delay_days?: number
          flow_id: string
          id?: string
          is_active?: boolean
          order_index?: number
          scheduled_day_offset?: number | null
          scheduled_time?: string | null
          step_type: string
          tenant_id?: string
        }
        Update: {
          content?: string | null
          created_at?: string
          delay_days?: number
          flow_id?: string
          id?: string
          is_active?: boolean
          order_index?: number
          scheduled_day_offset?: number | null
          scheduled_time?: string | null
          step_type?: string
          tenant_id?: string
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
          created_at: string
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
          created_at?: string
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
          created_at?: string
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
          created_at: string
          external_id: string | null
          id: string
          metodo: string | null
          player_id: string | null
          status: string
          tenant_id: string
          valor: number
        }
        Insert: {
          created_at?: string
          external_id?: string | null
          id?: string
          metodo?: string | null
          player_id?: string | null
          status?: string
          tenant_id?: string
          valor: number
        }
        Update: {
          created_at?: string
          external_id?: string | null
          id?: string
          metodo?: string | null
          player_id?: string | null
          status?: string
          tenant_id?: string
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
      admin_platform_metrics: {
        Args: { _from?: string; _to?: string }
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
          tenant_id: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "email_campaigns"
          isOneToOne: false
          isSetofReturn: true
        }
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
          tenant_id: string
          total_count: number
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
      consume_dispatch_budget: {
        Args: { p_channel: string; p_want: number }
        Returns: number
      }
      current_tenant_id: { Args: never; Returns: string }
      dashboard_totals: {
        Args: { _from: string; _reset_at: string; _tenant: string; _to: string }
        Returns: Json
      }
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
      recover_stuck_email_campaigns: { Args: never; Returns: number }
      recover_stuck_email_leads: { Args: never; Returns: number }
      recover_stuck_sms_campaigns: { Args: never; Returns: number }
      recover_stuck_sms_leads: { Args: never; Returns: number }
      register_provider_throttle: {
        Args: {
          p_channel: string
          p_error: string
          p_retry_after_seconds: number
        }
        Returns: undefined
      }
    }
    Enums: {
      app_role: "admin" | "user" | "super_admin" | "owner" | "member"
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
  public: {
    Enums: {
      app_role: ["admin", "user", "super_admin", "owner", "member"],
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
